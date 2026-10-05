import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig } from "../config";
import { baseStackConfig } from "../test-support/stack-config";
import { makeProvider } from "./providers";

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: args.inputs,
    }),
    call: () => ({}),
  },
  "grid-oib",
  "test",
  false,
);

describe("Kubernetes provider", () => {
  it("updates ConfigMaps in place without disabling server-side apply", async () => {
    pulumi.runtime.setAllConfig(baseStackConfig());
    const provider = makeProvider(loadConfig());
    const mutable = await new Promise<boolean | undefined>((resolve) =>
      provider.enableConfigMapMutable.apply(resolve),
    );
    const serverSideApply = await new Promise<boolean | undefined>((resolve) =>
      provider.enableServerSideApply.apply(resolve),
    );
    expect(mutable).toBe(true);
    expect(serverSideApply).toBe(true);
  });
});
