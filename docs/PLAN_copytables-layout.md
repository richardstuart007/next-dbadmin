# PLAN_copytables-layout — next-dbadmin

## Title
copytables: reorder count column, add source/target background colours

## Plan
- [x] Reorder comparison table columns per side in `src/components/CopyTableConn.tsx` so Count sits directly before Seq: order becomes Size(+Vacuum) → Count → Seq(+Fix), for both source and target. Update the `<th>` header order and the matching `<td>` body order, and reorder the Totals row cells to match.
- [x] Add `bg-gray-50` background to the first column group — select checkbox, Table, Status — both header and body cells, in `src/components/CopyTableConn.tsx`.
- [x] Add `bg-blue-50` background to the source column group (Src Size, Src Count, Src Seq) — both header and body cells — matching the existing blue=source convention used in the DDL diff view.
- [x] Add `bg-orange-50` background to the target column group (Tgt Size, Tgt Count, Tgt Seq) — both header and body cells — matching the existing orange=target convention used in the DDL diff view.
- [x] Leave the Counts (Match/Differs) and Actions columns unstyled — they belong to neither group.

## Changes
### src/components/CopyTableConn.tsx
- Reordered the per-side comparison columns from Count → Size → Seq to Size(+Vacuum) → Count → Seq(+Fix), so Count sits directly before Seq. Updated the header `<th>` order, the body `<td>` order, and the Totals row cell positions (the size subtotal now falls under the 4th/7th columns) to match.
- Removed the blanket `bg-gray-50` from `<thead>` and applied it per-column instead: `bg-gray-50` on the checkbox/Table/Status header and body cells, `bg-blue-50` on the source group (Size/Count/Seq), `bg-orange-50` on the target group (Size/Count/Seq). The existing conditional `bg-red-50` "sequence out of sync" warning still overrides the group colour on the Seq cells. Counts and Actions columns remain unstyled.

## Testing
- [ ] Open the Copy Tables tab, pick a source and target connection, and click Load Tables.
- [ ] Confirm each side's columns read Size → Count → Seq (with the Vacuum/Fix buttons in their usual spots) instead of the old Count → Size → Seq order.
- [ ] Confirm the checkbox/Table/Status columns have a light grey background, the source columns (Size/Count/Seq) have a light blue background, and the target columns have a light orange background.
- [ ] Confirm the Totals row still shows the correct MB subtotal under each side's Size column (not shifted to the wrong column).
- [ ] Find a table with an out-of-sync sequence (red ⚠ warning) and confirm its Seq cell still shows the red warning background instead of the blue/orange group colour.
- [ ] Confirm the DDL diff panel (click a "Different" status badge) still expands correctly across the full row width.
