import { describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { loadConfig } from "../config";
import { baseStackConfig } from "../test-support/stack-config";
import { makeProvider } from "./providers";

const RESOURCES: pulumi.runtime.MockResourceArgs[] = [];

pulumi.runtime.setMocks(
  {
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      RESOURCES.push(args);
      return { id: `${args.name}-id`, state: args.inputs };
    },
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
    await new Promise<string>((resolve) => provider.urn.apply(resolve));
    const registered = RESOURCES.find(
      (resource) => resource.type === "pulumi:providers:kubernetes" && resource.name === "grid-k8s",
    );
    expect(registered?.inputs).toMatchObject({
      enableConfigMapMutable: true,
      enableServerSideApply: true,
    });
  });
});
