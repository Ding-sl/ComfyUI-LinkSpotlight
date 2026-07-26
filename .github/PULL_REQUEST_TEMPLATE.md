# Pull Request

## What does this PR do?

<!-- Short description of the change and the motivation behind it. -->

## How was it tested?

- ComfyUI version:
- Frontend version (`comfyui-frontend-package`, see Settings → About):
- Browser / OS:

<!-- Describe the scenarios you ran (see the manual test checklist in
CONTRIBUTING.md). -->

## Checklist

- [ ] I ran the manual test checklist from `CONTRIBUTING.md`
- [ ] No graph/workflow state is mutated (nothing leaks into saved JSON)
- [ ] No settings-store reads were added to render hot paths
- [ ] Canvas state (`globalAlpha`, `editor_alpha`) is restored in `finally`
- [ ] New internal-API usage is guarded in `patchCanvas` and degrades cleanly
- [ ] README / settings documentation updated if behavior changed
