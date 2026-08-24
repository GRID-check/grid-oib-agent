import type { DeepResearchTodo, DeepResearchTodoStatus } from '../types'

type RawDeepResearchTodo = {
  content: string
  status: string
}

const normalizeDeepResearchTodoStatus = (status: string): DeepResearchTodoStatus => {
  if (status === 'pending' || status === 'in_progress' || status === 'completed') {
    return status
  }
  if (status === 'stopped' || status === 'cancelled') {
    return 'stopped'
  }
  // Unknown status: fall back to 'pending' so the UI stays functional, but
  // surface it in dev so new backend statuses don't get silently swallowed.
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      `[deep-research-todos] Unknown todo status "${status}" — falling back to "pending".`
    )
  }
  return 'pending'
}

export const normalizeDeepResearchTodos = (
  todos: RawDeepResearchTodo[]
): DeepResearchTodo[] => {
  return todos.map((todo, index) => ({
    id: `todo-${index}-${todo.content.substring(0, 20).replace(/\s+/g, '-').toLowerCase()}`,
    content: todo.content,
    status: normalizeDeepResearchTodoStatus(todo.status),
  }))
}
