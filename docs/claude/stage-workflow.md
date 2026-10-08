# Stage workflow

The owner's master prompt defines 16 mandatory stages. Status lives in `docs/STAGES.md`.

## Rules
- Complete **exactly one stage**, then stop. Unused time or tokens are never a reason to
  continue.
- A bare "Go" / "yes" right after an approval request approves the stage that was asked
  about. If the owner names a stage that is already finished, ask which one they mean.
- Change requests between stages (e.g. "make the monitors realistic") are done, tested
  and committed as a follow-up, then the same approval question is asked again.
- Messages meant for another session ("my bad, stop it") → revert only the uncommitted
  changes made for that message.

## Per-stage checklist
1. Implement (backend + frontend + migration if needed).
2. `make lint`, backend and frontend unit tests, full e2e.
3. Clean-copy check: `git checkout-index -a --prefix=<tmp>/` → `make setup` →
   `SMOKE_API_PORT=… SMOKE_WEB_PORT=… make smoke`.
4. Secret scan: the real `NVIDIA_API_KEY` / `NEXUS_SECRET_KEY` must not appear in tracked
   files or in `.next`, `.next-e2e`.
5. Screenshots with real Chrome (GPU flags) and inspect them; fix visual problems.
6. When useful, a small real-NVIDIA check on a **copy** of the dev DB (separate port);
   report the number of requests used.
7. Update `docs/STAGES.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, README status,
   `frontend/src/lib/stages.ts` (`CURRENT_STAGE`) and `NextStageCard.tsx`.
8. One local commit: `Stage N: <title>`. Never push.

## Report format (send screenshots first)
```
## NEXUS AI — STAGE X COMPLETE
### Implemented Features
### Visual Results
### Files Changed
### Tests            (PASS / FAIL / NOT TESTED — only tests that actually ran)
### Current Limitations
### Next Stage
### Approval Request
Stage X is complete. Do you approve starting Stage Y, or would you like any changes before we continue?
```
Then stop.

## Stages
1 Repo/architecture · 2 3D office · 3 Characters · 4 Departments/org · 5 NVIDIA ·
6 Text chat · 7 Voice · 8 Multi-agent orchestration · 9 Email · 10 Profiles & ratings ·
11 Executive dashboard & projects · 12 Meetings · 13 Memory/knowledge ·
14 Advanced office simulation (floor expansion) · 15 Security/automation/reliability ·
16 Final polish.
