#!/bin/bash
#
# Stop hook: refuse to end a turn with work that is not committed and pushed.
#
# WHY THIS FILE LIVES IN THE REPO.
#
# The harness invokes ~/.claude/stop-hook-git-check.sh by its own convention —
# no settings file registers it. That directory is outside the repo and gets
# restored from the image, so a fix applied there is reverted the next time the
# container is rebuilt. On 02-08-2026 the same two faults were corrected twice
# and came back twice. This copy is the source of truth; scripts/install-stop-
# hook.sh copies it into place, and .claude/settings.json runs the installer on
# SessionStart so the correction survives.
#
# TWO CORRECTIONS vs the stock hook, both false-positive fixes:
#
#   1. RANGE. The stock version compared HEAD against origin/<branch>, falling
#      back to origin/HEAD when the branch has no remote counterpart. After a
#      merge to main that fallback makes every commit on the working branch
#      look local, so commits that are demonstrably ON the remote get flagged.
#      `HEAD --not --remotes=origin` asks the real question: is this commit
#      reachable from ANY origin ref? Pushed work is silent regardless of which
#      branch it landed on.
#
#   2. SIGNATURE TEST. The stock version treated `%G? == N` as "unsigned". %G?
#      reports on VERIFICATION, and CCR does not configure a local keyring — so
#      a correctly signed commit reports N here and gets flagged forever, with
#      no amend able to fix it. The presence of a `gpgsig` header in the raw
#      commit object is the fact we can actually establish locally; GitHub does
#      the verifying.

input=$(cat)

# Recursion guard: don't re-run inside a stop triggered by this hook.
stop_hook_active=$(echo "$input" | jq -r '.stop_hook_active' 2>/dev/null)
if [[ "$stop_hook_active" = "true" ]]; then
  exit 0
fi

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# No remote means every error path below ("push to the remote branch") is
# unsatisfiable. Arises when CCR is launched against a local repo with no
# GitHub remote and the container's cwd has a leftover .git from a cached
# resume.
if [[ -z "$(git remote)" ]]; then
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "There are uncommitted changes in the repository. Please commit and push these changes to the remote branch." >&2
  exit 2
fi

untracked_files=$(git ls-files --others --exclude-standard)
if [[ -n "$untracked_files" ]]; then
  echo "There are untracked files in the repository. Please commit and push these changes to the remote branch." >&2
  exit 2
fi

current_branch=$(git branch --show-current)
if [[ -n "$current_branch" ]]; then
  # Correction 1: everything not reachable from any origin ref.
  local_only=(HEAD --not --remotes=origin)

  # Correction 2: signature PRESENCE, not local verifiability. Only meaningful
  # when signing is configured at all.
  if [[ "$(git config --type=bool commit.gpgsign 2>/dev/null)" == "true" ]]; then
    unverifiable=""
    while read -r sha; do
      [[ -z "$sha" ]] && continue
      reason=""
      # Header block ends at the first blank line; stop there so a message body
      # mentioning "gpgsig" cannot pass as a signature.
      if ! git cat-file commit "$sha" 2>/dev/null | sed -n '/^$/q;p' | grep -q '^gpgsig'; then
        reason="no signature"
      fi
      email=$(git log -1 --format='%ce' "$sha" 2>/dev/null)
      if [[ "$email" != "noreply@anthropic.com" ]]; then
        reason="${reason:+$reason, }committer email $email"
      fi
      if [[ -n "$reason" ]]; then
        unverifiable+="$(git log -1 --format='%h' "$sha") $reason"$'\n'
      fi
    done < <(git rev-list "${local_only[@]}" 2>/dev/null)

    if [[ -n "$unverifiable" ]]; then
      echo "There are unpushed commit(s) that GitHub will show as Unverified (missing signature, or committer email is not noreply@anthropic.com):" >&2
      printf '%s' "$unverifiable" >&2
      echo "Please run 'git config user.email noreply@anthropic.com && git config user.name Claude', then 'git commit --amend --no-edit --reset-author' for the tip commit, or rebase with --exec for earlier commits, then push." >&2
      exit 2
    fi
  fi

  unpushed=$(git rev-list "${local_only[@]}" --count 2>/dev/null) || unpushed=0
  if [[ "$unpushed" -gt 0 ]]; then
    echo "There are $unpushed unpushed commit(s) on branch '$current_branch'. Please push these changes to the remote repository." >&2
    exit 2
  fi
fi

exit 0
