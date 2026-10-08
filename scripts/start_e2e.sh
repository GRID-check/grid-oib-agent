#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
UI_DIR="$PROJECT_ROOT/frontends/ui"

# Default config file
CONFIG_FILE="configs/config_oib_openrouter.yml"

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --config_file)
            CONFIG_FILE="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [OPTIONS]"
            echo ""
            echo "Options:"
            echo "  --config_file <path>  Path to config file (default: configs/config_oib_openrouter.yml)"
            echo "  --help, -h            Show this help message"
            echo ""
            echo "Example:"
            echo "  $0 --config_file configs/config_oib_openrouter.yml"
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Validate config file exists
if [ ! -f "$PROJECT_ROOT/$CONFIG_FILE" ]; then
    echo "Error: Config file not found: $CONFIG_FILE"
    echo "Usage: $0 --config_file <path>"
    echo "Example: $0 --config_file configs/config_oib_openrouter.yml"
    exit 1
fi

cleanup() {
    echo ""
    echo "Shutting down services..."
    # ${VAR:-} guards: under `set -u` these may be unset if the user
    # interrupts before the corresponding service was started.
    if [ ! -z "${BACKEND_PID:-}" ]; then
        kill $BACKEND_PID 2>/dev/null || true
    fi
    if [ ! -z "${CHAT_PID:-}" ]; then
        kill $CHAT_PID 2>/dev/null || true
    fi
    if [ ! -z "${FRONTEND_PID:-}" ]; then
        kill $FRONTEND_PID 2>/dev/null || true
    fi
    exit 0
}

trap cleanup SIGINT SIGTERM

echo "================================================"
echo "Starting AI-Q Blueprint (End-to-End)"
echo "================================================"
echo ""

check_env() {
    export AIQ_DEV_ENV=e2e
    echo "Set AIQ_DEV_ENV=e2e"

    if [ -f "./deploy/.env" ]; then
        set -a  # Automatically export all variables
        source ./deploy/.env
        set +a  # Stop auto-exporting
        echo "Backend environment file loaded (deploy/.env)"
    else
        echo "No deploy/.env file found (optional)"
    fi

    # Suppress Python warnings unless overridden by .env
    export PYTHONWARNINGS="${PYTHONWARNINGS:-ignore}"

    # For local E2E the backend runs as its two web roles (ADR-0082): the api role
    # on localhost:8000 for every HTTP call, the chat role on localhost:8001 for
    # the WebSocket. The gateway requires BACKEND_CHAT_URL and does not fall back
    # to BACKEND_URL.
    export BACKEND_URL="http://localhost:8000"
    export BACKEND_CHAT_URL="http://localhost:8001"
    export NEXT_PUBLIC_BACKEND_URL="http://localhost:8000"
    echo "Backend URL for e2e: $BACKEND_URL (api), $BACKEND_CHAT_URL (chat)"
}

check_dependencies() {
    echo "Checking Python dependencies..."

    if ! python -c "import nat" 2>/dev/null; then
        echo "NAT not installed. Installing dependencies..."
        pip install -e .
    fi

    echo "Python dependencies installed"
}

check_ui_dependencies() {
    if [ ! -d "$UI_DIR" ]; then
        echo "UI directory not found at $UI_DIR"
        echo "Skipping frontend startup"
        return 1
    fi

    cd "$UI_DIR"

    if [ ! -d "node_modules" ]; then
        echo "Installing UI dependencies..."
        if command -v npm &> /dev/null; then
            npm ci
            echo "UI dependencies installed"
        else
            echo "npm not found. Skipping UI setup."
            echo "   Install Node.js 22+ to enable UI features"
            cd "$PROJECT_ROOT"
            return 1
        fi
    else
        echo "UI dependencies already installed"
    fi

    cd "$PROJECT_ROOT"
    return 0
}

start_backend() {
    echo ""
    echo "================================================"
    echo "Starting NAT Backend Server (Hot Reload Enabled)..."
    echo "================================================"
    echo ""
    echo "Backend api role will be available at: http://localhost:8000"
    echo "Backend chat role will be available at: http://localhost:8001"
    echo "Backend will auto-reload on code changes"
    echo "Config: $CONFIG_FILE"
    echo ""

    GRID_ROLE=api nat serve --config_file "$CONFIG_FILE" --host 0.0.0.0 --port 8000 &
    BACKEND_PID=$!
    echo "Backend api PID: $BACKEND_PID"

    GRID_ROLE=chat nat serve --config_file "$CONFIG_FILE" --host 0.0.0.0 --port 8001 &
    CHAT_PID=$!
    echo "Backend chat PID: $CHAT_PID"
}

wait_for_backend() {
    echo "Waiting for backend to be ready..."
    local max_attempts=150
    local attempt=1

    while [ $attempt -le $max_attempts ]; do
        if curl -s -f http://localhost:8000/health > /dev/null 2>&1 || \
           curl -s -f http://localhost:8000/docs > /dev/null 2>&1; then
            echo "Backend is ready!"
            return 0
        fi
        echo -n "."
        sleep 1
        attempt=$((attempt + 1))
    done

    echo ""
    echo "Backend health check timeout after ${max_attempts}s"
    echo "   Continuing anyway - frontend may encounter initial connection errors"
    return 1
}

start_frontend() {
    if [ ! -d "$UI_DIR" ]; then
        return
    fi

    echo ""
    echo "================================================"
    echo "Starting UI Frontend..."
    echo "================================================"
    echo ""
    echo "Frontend will be available at: http://localhost:3000"
    echo ""

    cd "$UI_DIR"

    npm run dev &
    FRONTEND_PID=$!
    echo "Frontend PID: $FRONTEND_PID"

    cd "$PROJECT_ROOT"
}

main() {
    check_env
    echo ""

    check_dependencies
    echo ""

    if check_ui_dependencies; then
        HAS_UI=true
    else
        HAS_UI=false
    fi
    echo ""

    start_backend
    wait_for_backend

    if [ "$HAS_UI" = true ]; then
        start_frontend
    else
        echo ""
        echo "WARNING: Frontend will NOT be started."
        echo "   Reason: UI dependencies not available (missing npm or node_modules)"
        echo "   To fix: install Node.js 22+ and run 'npm ci' in frontends/ui/"
        echo "   The backend will still run at http://localhost:8000"
        echo ""
    fi

    echo ""
    echo "================================================"
    echo "Services Started"
    echo "================================================"
    echo ""
    echo "Backend api: http://localhost:8000"
    echo "Backend chat: http://localhost:8001"
    if [ "$HAS_UI" = true ]; then
        echo "Frontend: http://localhost:3000"
    else
        echo "Frontend: SKIPPED (see warning above)"
    fi
    echo ""
    echo "Press Ctrl+C to stop all services"
    echo ""

    wait
}

main
