# Visit Outcome Changes — OTHER + Sub-outcome

Implement a fixed Visit Outcome list with custom outcome support. Inspect only visit-related code. Do not analyze the entire project or unrelated modules.

## Current behavior (already inspected)

There is no `subOutcome` anywhere, and no outcome list. Visit outcome is free text.

- `outcome` is an optional plain string on the `Visit` schema. No enum.
- `CheckOutDto` accepts `outcome` as `@IsOptional() @IsString()`. Any text is accepted.
- `checkOut` in the visit service sets `visit.outcome = dto.outcome` only when it is provided. A check-out that omits `outcome` keeps the old value.
- `CheckInDto` has no outcome field. Do not add one.
- `ListVisitsQuery` has `userId`, `from`, `to` only. There is no outcome filter.
- The only existing enum is `Role`, a TypeScript enum. Follow that style.
- Visit uses `tenantPlugin` and its existing indexes. Do not change them.
- Legacy visits have free-text `outcome` and no `subOutcome`. No migration is required.

`subOutcome` / `VisitOutcome` currently has zero matches.

## Required behavior

- Add a new `VisitOutcome` TypeScript enum with exactly these values: `ORDER_PLACED`, `SAMPLE_GIVEN`, `FOLLOW_UP`, `DOCTOR_UNAVAILABLE`, `NOT_INTERESTED`, `OTHER`.
- `CheckOutDto.outcome`: `@IsOptional() @IsEnum(VisitOutcome)`.
- Add optional `subOutcome` to `CheckOutDto`: `@IsOptional() @IsString() @MaxLength(100)`, trimmed with `@Transform` from class-transformer.
- `subOutcome` is required when `outcome` is `OTHER`, and must be absent otherwise (`@ValidateIf`). Use 400 validation errors, not service exceptions.
- Add optional `subOutcome?: string` to the `Visit` schema. Keep `outcome` as `string` (no Mongo enum), so legacy values stay readable.
- In `checkOut`:
  - Predefined outcome: store `outcome`, and clear any stale `subOutcome`.
  - `OTHER`: store `outcome: "OTHER"` and the trimmed `subOutcome`.
  - A check-out that omits both `outcome` and `subOutcome` leaves both unchanged.
- Add optional `outcome` filter to `ListVisitsQuery` (`@IsOptional() @IsEnum(VisitOutcome)`) and apply it in `list` as `filter.outcome`. `outcome=OTHER` returns all OTHER visits regardless of `subOutcome`.
- Do not change roles, scope rules, check-in, geofence logic, indexes or the tenant plugin.

## Files

Only touch these. Do not search the rest of the repo.

- `src/common/enums/visit-outcome.enum.ts` (new)
- `src/modules/visit/visit.schema.ts`
- `src/modules/visit/dto/visit.dto.ts`
- `src/modules/visit/visit.service.ts`
- `src/common/enums/role.enum.ts` (style reference only, do not edit)

## Done when

- `npm run build` passes.
- Only the files listed above changed.
