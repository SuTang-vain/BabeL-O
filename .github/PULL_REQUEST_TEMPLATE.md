## Summary

<!-- What changed? Keep this to one semantic slice. -->

## Risk Level

<!-- Choose one: review-light / review-standard / review-high-risk / review-emergency -->

## Scope

<!-- Name the files/modules and ownership boundary. -->

## Behavior Changed

<!-- User-visible or runtime-visible behavior, if any. Write "None; behavior-neutral" if applicable. -->

## Regression Evidence

<!-- Real session id, issue link, failing test, or "None". -->

## Verification

<!-- Paste the commands you ran. Examples: npm run typecheck, npm test, npm run docs:check. -->

## Docs Updated

<!-- Link docs changed or explain why none were needed. -->

## Flaky / Quarantine Impact

<!-- New flaky risk? Existing flaky touched? Quarantine entry needed? -->

## Rollback Notes

<!-- For risky changes, explain how to revert or disable safely. -->

## Checklist

- [ ] This PR closes one semantic slice.
- [ ] I ran the smallest useful focused test.
- [ ] I ran the required broader checks for the touched area.
- [ ] I updated docs/TODO/WORK_LOG when the change affects planning or behavior.
- [ ] I did not weaken `npm test` determinism or depend on real user config.
