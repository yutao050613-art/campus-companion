# M4 entry approval

- Approval date: 2026-08-01 (Asia/Shanghai)
- Approver and accountable owner: Cedric
- User instruction: `开始M4`
- Accepted M3 main commit: `c9c773dba37e99efe48d31a7af714562cd5de742`
- Accepted post-merge quality-gates run: `30659092246`
- Accepted post-merge M3 quality run: `30659092274`

M4 is limited to the mock-only information-service payment flow: a server-priced 99-fen order
for each confirmed account, mock prepayment and settlement, payment-deadline compensation,
full refunds for paid orders when delivery becomes impossible, consent revocation, all-member
contact delivery, contact-read auditing, and the corresponding mini-program/API/worker surfaces.

M4 excludes WeChat Pay API v3, real payment credentials, drivers, vehicles, actual taxi fares,
transport orders, location tracking, and transport fulfilment. The mock gateway must be disabled
outside development and test environments.
