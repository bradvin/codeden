---
section: added
---

- **Hold an issue out of the factory loop.** An issue labelled `factory:hold` is never taken in or started by the software or dark factory: an item of it still waiting in the queue is parked, and work already in progress carries on. Removing the label releases it on the next check. The project manager holds and releases issues with `factory_hold_issue` and `factory_release_issue`, each with an optional reason that is recorded and posted on the issue. The Factory view lists held issues under Intake as "Held" with the reason.
- **A project manager's stop isn't a failure.** When the project manager stops a factory builder or reviewer with a reason (held, superseded, waiting on another pull request), the item is recorded as stopped by the PM with that reason and never counts towards the pause after failures in a row. Failures by the builder, CI or the review still count, and Retry runs the item again.
