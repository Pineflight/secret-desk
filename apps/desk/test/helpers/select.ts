import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * Chooses an option in a `SelectBox` (a combobox button that opens a listbox in a portal).
 * `field` is the combobox element.
 */
export async function pick(user: UserEvent, field: HTMLElement, option: string | RegExp): Promise<void> {
  await user.click(field);
  await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: option }));
}

/** Same as `pick`, finding the combobox by its accessible label. */
export async function pickOption(user: UserEvent, label: string | RegExp, option: string | RegExp): Promise<void> {
  await pick(user, screen.getByRole("combobox", { name: label }), option);
}
