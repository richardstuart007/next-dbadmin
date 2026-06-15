# Plan — next-dbadmin, "version": "1.0.0"

## Current task: Update to nextjs-shared v2.0.5
- [x] Fix `nextjs-shared` in package.json from `"1.0.0"` → `"github:richardstuart007/nextjs-shared"`
- [ ] Remove-Item -Recurse -Force node_modules
- [ ] Remove-Item -Force package-lock.json
- [ ] npm install
- [ ] Remove-Item -Recurse -Force .next
- [ ] npx tsc --noEmit
- [ ] npm run build
- [ ] Commit

## Outstanding items
_(none)_
