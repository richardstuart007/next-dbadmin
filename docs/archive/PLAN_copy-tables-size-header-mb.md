# Title

Copy Tables tab: clarify size column units

## Plan

- [x] Change column heading "Src Size" to "Src Size(Mb)" in [CopyTableConn.tsx](src/components/CopyTableConn.tsx)
- [x] Change column heading "Tgt Size" to "Tgt Size(Mb)" in [CopyTableConn.tsx](src/components/CopyTableConn.tsx)
- [x] Remove " MB" suffix from source size row values
- [x] Remove " MB" suffix from target size row values

## Changes

### src/components/CopyTableConn.tsx
- Column heading "Src Size" → "Src Size(Mb)"
- Column heading "Tgt Size" → "Tgt Size(Mb)"
- Source size row value no longer appends " MB" (unit now only in the heading)
- Target size row value no longer appends " MB" (unit now only in the heading)

## Testing
- [ ] Open the Copy Tables tab and confirm the column headings read "Src Size(Mb)" and "Tgt Size(Mb)"
- [ ] Confirm the size values in each row show just the number (no "MB" suffix), still comma-formatted
- [ ] Confirm the Vacuum Full buttons next to each size still work as before

