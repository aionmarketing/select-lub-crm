# Local POC transcripts (gitignored)

Place labeled Evolution POC threads here for GitHub #6 quality scoring. Files in this directory are gitignored except this README. Do not commit WhatsApp bodies (same rule as `docs/poc-evolution-baileys.md` / PEND-CH-01).

Copy from the local POC dump (`artifacts/evolution-webhooks/`, also gitignored). Add a sibling labels object with expected v1 keys only (`name`, `taxId`, `plate`, `make`, `model`, `version`, `year`, `odometerKm`). The scorer in task 6.1 reads this folder when it exists; CI does not require it.
