import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Picks an option in a `SelectBox` (custom combobox): opens it by its label and clicks the option in the listbox. */
export async function pickOption(user: UserEvent, label: string | RegExp, option: string | RegExp): Promise<void> {
  await user.click(screen.getByRole("combobox", { name: label }));
  await user.click(within(await screen.findByRole("listbox")).getByRole("option", { name: option }));
}
