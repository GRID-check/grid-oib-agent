#!/usr/bin/env python3
"""Name each image by what goes into it, and decide which images a CI run must build.

An image is a function of its Dockerfile, the files the Dockerfile copies out of
its build context, and its base images. The first two are read here, from git,
so the name is exact: `inputs-<hash>`. The base images are tags that float
(`node:22-slim`, `debian:bookworm-slim`), so the ISO week goes into the hash as
well. An image is therefore never reused across a week boundary, and a patched
base reaches every image within seven days without anyone asking for it.

Why a hash and not a path filter. Publish Images used to diff each push against
the commit before it and rebuild only the images whose paths changed. Two things
broke that, both silently:

- The path lists were written by hand, twice, and disagreed with the
  Dockerfile. `deploy/Dockerfile` copies `packages/ifc-spatial-py/`, and neither
  list watched it, so a change there never reached a published image.
- A push that is superseded while queued is dropped, and the next push diffs
  only against its own parent. On 2026-10-09 a merge train of nine commits
  built the web image and nothing else: the frontend and backend changes of
  five merged pull requests were never built, and staging kept the old ones.

A hash of the inputs answers "is this image already built?" against the
registry, which is the one place that knows, so a dropped run costs nothing.

Usage:
  image_inputs.py hashes [REV]                  JSON {image: hash} for REV (default HEAD)
  image_inputs.py inputs IMAGE                  the paths that make up IMAGE, one per line
  image_inputs.py plan --base REV               pull request: build what REV..HEAD changed
  image_inputs.py plan --registry OWNER         push: build what GHCR does not have yet

`plan` writes `build=<json list>` and `images=<json list>` to $GITHUB_OUTPUT.
`build` is the matrix of images this run must build; `images` is all three,
with their hashes, for the job that tags them.
"""

from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
from collections.abc import Callable
from dataclasses import asdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIND_PUBLISHED_TAG = ROOT / "deploy" / "pulumi" / "scripts" / "find-published-tag.sh"

# Bump to rename every image at once, e.g. after a change to how images are
# built that no input file records.
SCHEME = "1"


@dataclass(frozen=True)
class Image:
    name: str
    context: str
    dockerfile: str
    target: str = ""

    @property
    def repository(self) -> str:
        return f"grid-oib-{self.name}"


IMAGES = (
    Image("backend", context=".", dockerfile="deploy/Dockerfile", target="release"),
    Image("frontend", context="frontends/ui", dockerfile="frontends/ui/deploy/Dockerfile"),
    Image("web", context="frontends/web", dockerfile="frontends/web/Dockerfile"),
)

_INSTRUCTION = re.compile(r"^\s*(COPY|ADD)\s+(.*)$", re.IGNORECASE)


def _logical_lines(text: str) -> list[str]:
    """Dockerfile lines with `\\` continuations joined and comments dropped."""
    lines: list[str] = []
    pending = ""
    for raw in text.splitlines():
        if not pending and raw.lstrip().startswith("#"):
            continue
        if raw.rstrip().endswith("\\"):
            pending += raw.rstrip()[:-1] + " "
            continue
        lines.append(pending + raw)
        pending = ""
    if pending:
        lines.append(pending)
    return lines


def copy_sources(dockerfile_text: str) -> list[str]:
    """Every path a COPY or ADD takes from the build context, as written.

    `--from=` copies from another stage or image, not the context, so it is
    skipped. A glob is cut back to the directory before its first wildcard,
    which can only widen the inputs, never narrow them.
    """
    sources: list[str] = []
    for line in _logical_lines(dockerfile_text):
        match = _INSTRUCTION.match(line)
        if not match:
            continue
        rest = match.group(2).strip()
        args = json.loads(rest) if rest.startswith("[") else shlex.split(rest)
        flags = [arg for arg in args if arg.startswith("--")]
        if any(flag.startswith("--from") for flag in flags):
            continue
        paths = [arg for arg in args if not arg.startswith("--")]
        sources.extend(_cut_glob(path) for path in paths[:-1])
    return sources


def _cut_glob(path: str) -> str:
    parts = []
    for part in path.split("/"):
        if any(char in part for char in "*?["):
            break
        parts.append(part)
    return "/".join(parts) or "."


def _normalise(context: str, source: str) -> str:
    joined = os.path.normpath(os.path.join(context, source))
    if os.path.relpath(joined, context).split(os.sep)[0] == "..":
        raise ValueError(f"{source!r} leaves the build context {context!r}")
    return joined


def _git(*args: str) -> str:
    return subprocess.run(["git", *args], cwd=ROOT, check=True, capture_output=True, text=True).stdout


def inputs(image: Image, rev: str = "HEAD") -> list[str]:
    """The repository paths whose content is this image's content."""
    dockerfile = _git("show", f"{rev}:{image.dockerfile}")
    paths = {image.dockerfile, _normalise(image.context, ".dockerignore")}
    paths.update(_normalise(image.context, source) for source in copy_sources(dockerfile))
    return sorted(paths)


def iso_week(today: datetime.date) -> str:
    year, week, _ = today.isocalendar()
    return f"{year}-W{week:02d}"


def input_hash(image: Image, rev: str = "HEAD", *, week: str) -> str:
    """sha256 over the git blobs of every input, the target and the week."""
    paths = inputs(image, rev)
    listing = _git("ls-tree", "-r", "--full-tree", rev, "--", *paths)
    tracked = {line.split("\t", 1)[1] for line in listing.splitlines()}
    missing = [path for path in paths if path != image.dockerfile and not _covered(path, tracked)]
    # .dockerignore is optional; anything else the Dockerfile copies must exist,
    # or the hash would silently leave out a file the build then fails to find.
    missing = [path for path in missing if not path.endswith(".dockerignore")]
    if missing:
        raise ValueError(f"{image.dockerfile} copies {missing}, which {rev} does not track")
    digest = hashlib.sha256()
    for part in (SCHEME, image.name, image.target, week, listing):
        digest.update(part.encode())
        digest.update(b"\0")
    return digest.hexdigest()[:40]


def _covered(path: str, tracked: set[str]) -> bool:
    if path == ".":
        return bool(tracked)
    return path in tracked or any(name.startswith(path + "/") for name in tracked)


def hashes(rev: str = "HEAD", *, week: str) -> dict[str, str]:
    return {image.name: input_hash(image, rev, week=week) for image in IMAGES}


def _entry(image: Image, digest: str) -> dict[str, str]:
    return {**asdict(image), "repository": image.repository, "hash": digest}


def plan_pull_request(base: str, *, week: str) -> tuple[list[dict], list[dict]]:
    """Build an image when the pull request changes what goes into it.

    `base` is compared through its merge base with HEAD, the same three-dot
    reading the path filter uses, so a base that moved on does not count as a
    change the pull request made.
    """
    merge_base = _git("merge-base", base, "HEAD").strip()
    head, before = hashes("HEAD", week=week), hashes(merge_base, week=week)
    images = [_entry(image, head[image.name]) for image in IMAGES]
    return [entry for entry in images if head[entry["name"]] != before[entry["name"]]], images


Published = Callable[[str, str], bool | None]


def plan_push(published: Published, *, week: str) -> tuple[list[dict], list[dict]]:
    """Build an image unless the registry already has one with these inputs.

    `published(repository, tag)` answers True, False, or None when the registry
    could not say. None builds: an extra build costs minutes, a skipped one
    ships the wrong code.
    """
    head = hashes("HEAD", week=week)
    images = [_entry(image, head[image.name]) for image in IMAGES]
    return [entry for entry in images if published(entry["name"], f"inputs-{entry['hash']}") is not True], images


def registry_lookup(owner: str) -> Published:
    """Ask GHCR through the same script the deploy uses for its own lookups."""

    def published(name: str, tag: str) -> bool | None:
        result = subprocess.run(
            ["bash", str(FIND_PUBLISHED_TAG), owner, name, tag], capture_output=True, text=True, check=False
        )
        sys.stderr.write(result.stderr)
        return {0: True, 1: False}.get(result.returncode)

    return published


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("hashes").add_argument("rev", nargs="?", default="HEAD")
    sub.add_parser("inputs").add_argument("image", choices=[image.name for image in IMAGES])
    plan = sub.add_parser("plan")
    side = plan.add_mutually_exclusive_group(required=True)
    side.add_argument("--base")
    side.add_argument("--registry", metavar="OWNER")
    args = parser.parse_args(argv)

    week = iso_week(datetime.datetime.now(datetime.UTC).date())
    if args.command == "hashes":
        print(json.dumps(hashes(args.rev, week=week), indent=2))
        return 0
    if args.command == "inputs":
        print("\n".join(inputs(next(image for image in IMAGES if image.name == args.image))))
        return 0

    if args.base:
        build, images = plan_pull_request(args.base, week=week)
    else:
        build, images = plan_push(registry_lookup(args.registry), week=week)
    for entry in images:
        verdict = "build" if entry in build else "already built"
        print(f"{entry['name']}: inputs-{entry['hash']} ({verdict})")
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as handle:
            handle.write(f"build={json.dumps(build)}\n")
            handle.write(f"images={json.dumps(images)}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
