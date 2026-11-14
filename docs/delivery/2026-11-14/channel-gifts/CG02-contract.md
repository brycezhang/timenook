# CG02 partner admin contract

AdminOperator.role is `super_admin` or `partner`; active Feishu identities receive all fixed admin permissions. Partner permissions are `channel-gifts:read` and `channel-gifts:write`. AdminAccess session sets request.adminRole and request.adminOperator; all service authority derives from the current persistent account, never request body or stored legacy permission arrays.

POST /v1/admin/partners returns id, username, disabled and a generated password once. GET lists metadata without credentials; POST /partners/:id/revoke disables only a partner in the current realm. POST /partner/login accepts username/password with anonymous cookie, Origin and CSRF, rotates into the existing Secure HttpOnly session, and uses Redis limits. A revoked account fails every subsequent protected access. History and gifts remain.

ChannelGift controller uses channelGiftsRead/Write. Partner GET filters by its authenticated operatorId. `scopedAdminGift(row, partner)` redacts buyerPhone, buyerId, associatedAt, projectId and orderId, adding usageStatus (`pending`, `activated`, `void`). CG04 should apply the same function to correction/void results and use current request role/operator to check ownership while holding the record lock. The shared admin component reads usageStatus for activated rows; partner entry is /admin/channel-gifts. Super-admin account management is /admin/partners.

Local real PostgreSQL/Redis HTTP role, session, CSRF, owner-list, buyer visibility and revocation checks pass. HTTPS browser acceptance passed; final evidence and external acceptance boundaries are in CG02-delivery.md.
