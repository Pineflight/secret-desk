import { InventoryError } from "@secret-desk/core";
import type { SudoAnswer, SudoMethod } from "@secret-desk/automation";

/**
 * The confirmation the human typed in the portal, checked. The typed value is wiped from `body` the moment it is read, so it lives
 * only in the returned answer (which the run wipes after typing). `methods` are the ways the page offers right now.
 */
export function sudoAnswerFrom(body: Record<string, unknown>, methods: readonly SudoMethod[]): SudoAnswer {
  const method = body["method"];
  let answer: SudoAnswer;
  if (method === "mobile") answer = { method };
  else if (method === "code") {
    const code = typeof body["code"] === "string" ? body["code"].replace(/\s+/g, "") : "";
    body["code"] = "";
    if (!/^[A-Za-z0-9-]{4,16}$/.test(code)) throw new InventoryError("The code is not valid (4 to 16 letters, digits or dashes).");
    answer = { method, code };
  } else if (method === "password") {
    const password = typeof body["password"] === "string" ? body["password"] : "";
    body["password"] = "";
    if (!password || password.length > 1024 || /[\u0000-\u001f\u007f]/.test(password)) throw new InventoryError("The password is not valid.");
    answer = { method, password };
  } else throw new InventoryError("Field method: mobile, code or password.");
  if (!methods.includes(answer.method)) throw new InventoryError("This way to confirm is not offered.");
  return answer;
}
