import React from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PricingSection } from "./PricingSection.jsx";

const apiMock = vi.hoisted(() => ({
  read: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../../lib/model-pricing-api", () => ({
  readModelPricing: apiMock.read,
  setModelPricingOverride: apiMock.set,
  deleteModelPricingOverride: apiMock.remove,
}));

vi.mock("../../lib/copy", () => ({
  copy: (key, params) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

const BASE_ITEM = {
  model: "claude-opus-5-5",
  source: null,
  status: "priced",
  origin: "curated",
  overridden: false,
  input: 4,
  output: 20,
  cache_read: 0.2,
  cache_write: 5,
};
const CUSTOM_ITEM = {
  ...BASE_ITEM,
  model: "private-model",
  source: "claude",
  origin: "custom",
  overridden: true,
  pricing_source: "user:source-exact",
  input: 7,
};

function catalog(items = [BASE_ITEM]) {
  return { items, total: items.length, revision: 3, override_count: items.filter((item) => item.overridden).length };
}

describe("PricingSection", () => {
  beforeEach(() => {
    apiMock.read.mockReset();
    apiMock.set.mockReset();
    apiMock.remove.mockReset();
    apiMock.read.mockResolvedValue(catalog());
    apiMock.set.mockResolvedValue({ ok: true });
    apiMock.remove.mockResolvedValue({ ok: true, deleted: true });
  });

  it("loads only while active and renders current rates", async () => {
    const view = render(React.createElement(PricingSection, { active: false }));
    expect(apiMock.read).not.toHaveBeenCalled();
    view.rerender(React.createElement(PricingSection, { active: true }));
    await waitFor(() => expect(apiMock.read).toHaveBeenCalledWith({ q: "", origin: "", limit: 50, offset: 0 }));
    expect(await screen.findByText("claude-opus-5-5")).toBeInTheDocument();
    expect(screen.getByText("20")).toBeInTheDocument();
    expect(screen.getByText("settings.model_pricing.origin.curated")).toBeInTheDocument();
  });

  it("fits the desktop table to its container instead of forcing the actions off-screen", async () => {
    const { container } = render(<PricingSection active />);
    await screen.findByText("claude-opus-5-5");

    expect(screen.getByRole("table")).toHaveClass("md:table-fixed", "md:min-w-0");
    expect(screen.getByRole("table")).not.toHaveClass("min-w-[760px]");
    expect(container.querySelectorAll("colgroup col")).toHaveLength(8);
  });

  it("edits a model with numeric rates and reloads after saving", async () => {
    const user = userEvent.setup();
    render(<PricingSection active />);
    await screen.findByText("claude-opus-5-5");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.edit claude-opus-5-5" }));
    });
    const input = screen.getByRole("spinbutton", { name: "settings.model_pricing.input" });
    await act(async () => {
      await user.clear(input);
      await user.type(input, "7.5");
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.save" }));
    });
    expect(apiMock.set).toHaveBeenCalledWith({
      model: "claude-opus-5-5",
      source: null,
      input: 7.5,
      output: 20,
      cache_read: 0.2,
      cache_write: 5,
    });
    await waitFor(() => expect(apiMock.read).toHaveBeenCalledTimes(2));
    expect(screen.getByText("settings.model_pricing.saved")).toBeInTheDocument();
  });

  it("rejects invalid rates without submitting", async () => {
    const user = userEvent.setup();
    render(<PricingSection active />);
    await screen.findByText("claude-opus-5-5");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.edit claude-opus-5-5" }));
    });
    await act(async () => {
      await user.clear(screen.getByRole("spinbutton", { name: "settings.model_pricing.input" }));
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.save" }));
    });
    expect(apiMock.set).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("settings.model_pricing.error.rate");
    expect(screen.getByRole("button", { name: "settings.model_pricing.save" })).toBeInTheDocument();
  });

  it("keeps the draft open and shows the backend error when saving fails", async () => {
    const user = userEvent.setup();
    apiMock.set.mockRejectedValue(new Error("disk full"));
    render(<PricingSection active />);
    await screen.findByText("claude-opus-5-5");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.edit claude-opus-5-5" }));
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.save" }));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("disk full");
    expect(screen.getByRole("spinbutton", { name: "settings.model_pricing.input" })).toHaveValue(4);
  });

  it("adds an unlisted model with an optional provider", async () => {
    const user = userEvent.setup();
    render(<PricingSection active />);
    await screen.findByText("claude-opus-5-5");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.add" }));
    });
    await act(async () => {
      await user.type(screen.getByRole("textbox", { name: "settings.model_pricing.model" }), "my-model");
      await user.type(screen.getByRole("textbox", { name: "settings.model_pricing.provider_optional" }), "Claude");
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.save" }));
    });
    expect(apiMock.set).toHaveBeenCalledWith({
      model: "my-model",
      source: "claude",
      input: 0,
      output: 0,
      cache_read: 0,
      cache_write: 0,
    });
  });

  it("confirms restoring a custom price and supports custom-only filtering", async () => {
    const user = userEvent.setup();
    apiMock.read.mockResolvedValue(catalog([CUSTOM_ITEM]));
    render(<PricingSection active />);
    await screen.findByText("private-model");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.custom_only" }));
    });
    await waitFor(() => expect(apiMock.read).toHaveBeenCalledWith({ q: "", origin: "custom", limit: 50, offset: 0 }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.restore_default private-model" }));
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.confirm_restore" }));
    });
    expect(apiMock.remove).toHaveBeenCalledWith(CUSTOM_ITEM);
    expect(screen.getByText("settings.model_pricing.restored")).toBeInTheDocument();
  });

  it("does not offer restore on a provider row that only inherits a global override", async () => {
    apiMock.read.mockResolvedValue(catalog([{ ...CUSTOM_ITEM, pricing_source: "user:exact" }]));
    render(<PricingSection active />);

    expect(await screen.findByText("private-model")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "settings.model_pricing.restore_default private-model" })).not.toBeInTheDocument();
  });

  it("refreshes without reporting success when the override was already removed", async () => {
    const user = userEvent.setup();
    apiMock.read.mockResolvedValue(catalog([CUSTOM_ITEM]));
    apiMock.remove.mockResolvedValue({ ok: true, deleted: false });
    render(<PricingSection active />);
    await screen.findByText("private-model");
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.restore_default private-model" }));
    });
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.confirm_restore" }));
    });

    expect(apiMock.remove).toHaveBeenCalledWith(CUSTOM_ITEM);
    expect(screen.queryByText("settings.model_pricing.restored")).not.toBeInTheDocument();
    await waitFor(() => expect(apiMock.read).toHaveBeenCalledTimes(2));
  });

  it("submits search and advances pagination", async () => {
    const user = userEvent.setup();
    apiMock.read.mockResolvedValue({ ...catalog(), total: 80 });
    render(<PricingSection active />);
    await screen.findByText("claude-opus-5-5");
    await act(async () => {
      await user.type(screen.getByRole("searchbox", { name: "settings.model_pricing.search_label" }), "opus");
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.search" }));
    });
    await waitFor(() => expect(apiMock.read).toHaveBeenCalledWith({ q: "opus", origin: "", limit: 50, offset: 0 }));
    await act(async () => {
      await user.click(screen.getByRole("button", { name: "settings.model_pricing.next" }));
    });
    await waitFor(() => expect(apiMock.read).toHaveBeenCalledWith({ q: "opus", origin: "", limit: 50, offset: 50 }));
  });
});
