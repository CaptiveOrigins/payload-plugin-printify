#!/bin/bash
# Blocks publishing private details. Exit 1 means something was found.
# Always checks for email addresses that aren't noreply or placeholders (example.com, the reserved .example and .test), and for committed binaries or build output.
# Locally it also checks for private terms. They live outside the repo, one per line, matched as whole words
# without regard to case, in the file named by LEAK_PRIVATE_TERMS (default ~/.leak-private-terms).
# The repo's own public names (its org, package scope, owner handle) don't belong in that file.
# CI has no terms file, so there it runs the other checks only.
# Lines containing a phrase from scripts/leak-allow.txt are skipped. Keep that list short and public.
set -u
cd "$(dirname "$0")/.."
TERMS="${LEAK_PRIVATE_TERMS:-$HOME/.leak-private-terms}"
ALLOW=scripts/leak-allow.txt
if git rev-parse --git-dir >/dev/null 2>&1; then
  FILES=$(git ls-files --cached --others --exclude-standard)
else
  FILES=$(find . -type f -not -path './.git/*' -not -path '*/node_modules/*' | sed 's|^\./||')
fi
FILES=$(echo "$FILES" | grep -v -E '(^|/)scripts/leak-(check\.sh|allow\.txt)$' || true)
[[ -n "$FILES" ]] || { echo "Leak check: nothing to scan"; exit 0; }
allowed() {
  if [[ -f "$ALLOW" ]]; then grep -v -F -f <(grep -v -E '^\s*(#|$)' "$ALLOW") || true; else cat; fi
}
scan() { echo "$FILES" | tr '\n' '\0' | xargs -0 grep -I -n "$@" 2>/dev/null; }
fail=0
if [[ -f "$TERMS" ]]; then
  pats=()
  while IFS= read -r term; do pats+=(-e "$term"); done < <(grep -v -E '^\s*(#|$)' "$TERMS")
  if [[ ${#pats[@]} -gt 0 ]]; then
    # Report places only, never the term itself, so the output is safe to paste anywhere.
    hits=$(scan -i -w -F "${pats[@]}" | allowed | cut -d: -f1,2)
    names=$(echo "$FILES" | grep -i -w -F "${pats[@]}" | allowed)
    if [[ -n "$hits$names" ]]; then echo "Private terms found at:"; echo "$names"; echo "$hits" | head -40; fail=1; fi
  fi
else
  echo "No private terms file, so only checking for email addresses and build output."
fi
emails=$(scan -o -E '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}' \
  | grep -v -E '@(users\.noreply\.github\.com|example\.(com|org|net)|anthropic\.com)$|\.(example|test|invalid|localhost)$|@[0-9]+x\.(png|jpe?g|gif|webp|svg)$' \
  | allowed)
[[ -n "$emails" ]] && { echo "Email addresses found:"; echo "$emails" | head -20; fail=1; }
built=$(echo "$FILES" | grep -E '\.(jar|class|zip|tgz|dmg|pkg|exe|dll|so|dylib|o|a)$|(^|/)(node_modules|dist|build|out|target|\.build|\.next|\.gradle|DerivedData)/' \
  | grep -v -E '(^|/)gradle-wrapper\.jar$' | allowed)
[[ -n "$built" ]] && { echo "Binaries or build output committed:"; echo "$built" | head -20; fail=1; }
[[ $fail == 0 ]] && echo "Leak check passed ($(echo "$FILES" | wc -l | tr -d ' ') files)"
exit $fail
