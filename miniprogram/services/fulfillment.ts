import type {
  FulfillmentView,
  FulfillmentGrantCommand,
} from "../../packages/contracts/src";
import { sessionClient } from "./session";
const uuid = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
const hash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const states = [
  "approved",
  "handoff_pending",
  "in_production",
  "shipped",
  "delivered",
  "cancellation_pending",
  "cancelled",
];
function view(value: FulfillmentView, projectId: string): FulfillmentView {
  if (
    !value ||
    value.projectId !== projectId ||
    (value.orderId !== null && !uuid(value.orderId)) ||
    !Array.isArray(value.attempts) ||
    typeof value.canGrant !== "boolean" ||
    typeof value.canGrantNarrator !== "boolean" ||
    value.grantMaxMinutes !== 30 ||
    !value.creation ||
    (value.accessExpiresAt !== null &&
      !Number.isFinite(Date.parse(value.accessExpiresAt))) ||
    (value.current &&
      (!uuid(value.current.id) ||
        !uuid(value.current.bookVersionId) ||
        !hash(value.current.snapshotHash) ||
        !hash(value.current.pdfHash) ||
        !hash(value.current.addressHash) ||
        (value.current.grantExpiresAt !== null &&
          !Number.isFinite(Date.parse(value.current.grantExpiresAt))) ||
        !states.includes(value.current.state) ||
        typeof value.current.handoffId !== "string" ||
        (value.current.tracking &&
          (typeof value.current.tracking.carrier !== "string" ||
            typeof value.current.tracking.number !== "string"))))
  )
    throw new Error("生产与物流状态无效，请重新查询");
  return value;
}
export const fulfillmentClient = {
  async grant(projectId: string, input: FulfillmentGrantCommand, key: string) {
    if (!uuid(projectId)) throw new Error("项目编号无效");
    return view(
      await sessionClient.request<FulfillmentView>(
        `/projects/${projectId}/fulfillment/grants`,
        { data: { ...input }, key },
      ),
      projectId,
    );
  },
  async read(projectId: string) {
    if (!uuid(projectId)) throw new Error("项目编号无效");
    return view(
      await sessionClient.request<FulfillmentView>(
        `/projects/${projectId}/fulfillment`,
      ),
      projectId,
    );
  },
};
