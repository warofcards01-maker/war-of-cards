# WAR OF CARDS 1.2.0 — Validation

Validated on Node.js 24.22.1, 8 November 2026.

- `npm run check`: passed (server.js, game.js, public/app.js syntax).
- `npm test`: 18 tests passed, 0 failed.
- Invalid Declare / Show adds 80 points immediately and leaves the player active in the SAME round: no drop, elimination, card removal, turn advancement, or timer extension.
- A normal non-winning discard does not add an 80-point penalty.
- Duplicate declaration request IDs do not apply the penalty again, including after a server restart.
- A valid declaration after the penalty still works; a deterministic two-deal fixture verifies score remains 80 and the correct ₹100 → ₹180 wallet settlement occurs once.
- Other checks include 320 table definitions (80 per mode), T1–T5 per capacity, deck / meld integrity, 2,000 synthetic names, private opponent hands, signup reply isolation, mandatory password change, admin authorization, request replay protection, withdrawal hold/refund, bot admission timing, cancellations and durable balances.
- Browser inspected: final public homepage, logo, gold/blue/purple landing theme and visible labels. Authenticated browser screens were not manually inspected; their backend flows were tested through HTTP.
- Mobile landscape and portrait CSS are included. Physical-phone fullscreen / orientation behavior and concurrent multiplayer load were not tested.
- No real bank transfers, WhatsApp messages or deployment were performed.

The mockup image is a visual guide. This implementation uses real HTML controls rather than a screenshot as the interface. Lobby labels use T1–T5 for both capacities, as requested earlier, even though the supplied reference contains legacy T6–T10 labels.

Tournament validation: See TOURNAMENTS.md. Seven dedicated tournament tests plus HTTP tournament booking/admin/refund assertions are included. The 1,000-seat test covers partitioning into 167 tables; this is not a 1,000-client concurrent load test. New authenticated tournament screens were not manually browser-tested.
