import os
import pathlib
import re
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]

DEFAULT_DIRS = [
    REPO_ROOT / "src" / "presentation",
    REPO_ROOT / "src" / "console",
    REPO_ROOT / "src",
    REPO_ROOT / "packages",
    REPO_ROOT / "examples",
    REPO_ROOT / "public",
    REPO_ROOT / "website",
    REPO_ROOT / "web",
    REPO_ROOT / "apps",
]

SKIP_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "data",
    "scripts",
    "skills",
}

EXTENSIONS = {
    ".md",
    ".mdx",
    ".html",
    ".htm",
    ".txt",
    ".tsx",
    ".ts",
    ".jsx",
    ".js",
    ".json",
    ".yml",
    ".yaml",
}

BANNED_TERMS = [
    "wallet",
    "gas",
    "chain",
    "private key",
    "seed phrase",
]

STRING_LITERAL_RE = re.compile(
    r"(?:'([^'\\]*(?:\\.[^'\\]*)*)'|\"([^\"\\]*(?:\\.[^\"\\]*)*)\"|`([^`\\]*(?:\\.[^`\\]*)*)`)"
)


def extract_string_literals(line: str) -> list[str]:
    matches = []
    for match in STRING_LITERAL_RE.finditer(line):
        for group in match.groups():
            if group is not None:
                matches.append(group)
    return matches


def strip_html_tags(line: str) -> str:
    return re.sub(r"<[^>]+>", " ", line)


def term_pattern(term: str) -> re.Pattern:
    words = term.split()
    if len(words) == 1:
        return re.compile(rf"\b{re.escape(term)}\b", re.IGNORECASE)
    joined = r"\s+".join(rf"\b{re.escape(word)}\b" for word in words)
    return re.compile(joined, re.IGNORECASE)


def find_roots(args):
    if args:
        return [pathlib.Path(arg).resolve() for arg in args]
    roots = [path for path in DEFAULT_DIRS if path.exists()]
    if roots:
        return roots
    return [REPO_ROOT]


def iter_files(roots):
    for root in roots:
        if root.is_file():
            yield root
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
            for filename in filenames:
                path = pathlib.Path(dirpath) / filename
                if path.suffix.lower() in EXTENSIONS:
                    yield path


def main():
    patterns = [(term, term_pattern(term)) for term in BANNED_TERMS]
    hits = []
    roots = find_roots(sys.argv[1:])

    for path in iter_files(roots):
        try:
            text = path.read_text(encoding="utf-8")
        except Exception:
            continue
        ext = path.suffix.lower()
        for line_no, line in enumerate(text.splitlines(), 1):
            if ext in {".ts", ".tsx", ".js", ".jsx"}:
                segments = extract_string_literals(line)
            elif ext in {".html", ".htm"}:
                segments = [strip_html_tags(line)]
            else:
                segments = [line]

            for segment in segments:
                for term, pattern in patterns:
                    if pattern.search(segment):
                        hits.append((path, line_no, term, line.strip()))

    if hits:
        print("[FAIL] Banned terms found in user-facing copy:")
        for path, line_no, term, line in hits[:200]:
            rel_path = path.relative_to(REPO_ROOT)
            print(f"  - {rel_path}:{line_no} contains '{term}': {line}")
        if len(hits) > 200:
            print(f"  ... and {len(hits) - 200} more")
        raise SystemExit(1)

    print("[OK] No banned terms found.")


if __name__ == "__main__":
    main()
