import { IssuanceWrittenError } from "@secret-desk/runtime";
import { describe, expect, it, vi } from "vitest";
import { route } from "../src/server/router.js";
import { routerFixture, uiRequest } from "./helpers/router-fixture";

// A reject that would revoke a value a write was started for is refused with the places (409) until the body acknowledges it.
const mocks = vi.hoisted(() => ({ reject: vi.fn() }));
vi.mock("@secret-desk/runtime", async (importOriginal) => ({ ...(await importOriginal<typeof import("@secret-desk/runtime")>()), rejectIssuance: mocks.reject }));

describe("POST reviews/:id/reject for a review a write was started for", () => {
  it("answers 409 with the code and the places, and takes the acknowledgement from the body", async () => {
    const { deps } = await routerFixture();
    mocks.reject.mockImplementation(async (_rt: unknown, _actor: unknown, _id: string, _note: unknown, options: { acknowledgeWritten?: boolean }) => {
      if (options.acknowledgeWritten !== true) throw new IssuanceWrittenError(["acme-app (repository)"]);
      return { revokedNew: true };
    });
    const refused = await route(uiRequest(deps, "POST", "reviews/r1/reject", {}), deps);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "write-started", places: ["acme-app (repository)"] });
    // Anything but the boolean `true` is not an acknowledgement.
    const stringy = await route(uiRequest(deps, "POST", "reviews/r1/reject", { acknowledgeWritten: "yes" }), deps);
    expect(stringy.status).toBe(409);
    const decided = await route(uiRequest(deps, "POST", "reviews/r1/reject", { acknowledgeWritten: true, note: "seen" }), deps);
    expect(decided.status).toBe(200);
    expect(await decided.json()).toEqual({ revokedNew: true });
    expect(mocks.reject).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), "r1", "seen", { acknowledgeWritten: true });
  });
});
