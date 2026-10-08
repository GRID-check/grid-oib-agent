import * as pulumi from "@pulumi/pulumi";

/**
 * The resource graph a program registers, read off the mock monitor.
 *
 * `MockResourceArgs` carries no dependencies, so a `newResource` mock cannot see
 * `dependsOn`. The request the SDK sends the monitor does: it lists the URNs the
 * resource waits on, explicit and through its inputs. Wrapping the monitor after
 * `setMocks` records them without changing what the mocks return.
 */
export interface RecordedResource {
  type: string;
  name: string;
  /** URNs this resource was registered with as direct dependencies. */
  dependencies: string[];
}

const urnOf = (type: string, name: string) =>
  `urn:pulumi:${pulumi.getStack()}::${pulumi.getProject()}::${type}::${name}`;

export class DependencyGraph {
  private readonly byUrn = new Map<string, RecordedResource>();

  /** Call after `pulumi.runtime.setMocks`. */
  constructor() {
    type Req = { getType(): string; getName(): string; getDependenciesList(): string[] };
    const monitor = pulumi.runtime.getMonitor() as unknown as {
      registerResource: (req: Req, ...rest: unknown[]) => unknown;
    };
    const register = monitor.registerResource.bind(monitor);
    monitor.registerResource = (req, ...rest) => {
      const type = req.getType();
      const name = req.getName();
      this.byUrn.set(urnOf(type, name), { type, name, dependencies: [...req.getDependenciesList()] });
      return register(req, ...rest);
    };
  }

  /** The recorded resource of this type and name; throws when the program never made it. */
  find(type: string, name: string): RecordedResource {
    const hit = this.byUrn.get(urnOf(type, name));
    if (!hit) throw new Error(`no ${type} named "${name}" was registered`);
    return hit;
  }

  /** Every resource the named one waits on, directly or through others. */
  closure(type: string, name: string): Set<string> {
    this.find(type, name);
    const seen = new Set<string>();
    const stack = [urnOf(type, name)];
    while (stack.length > 0) {
      const next = this.byUrn.get(stack.pop() as string);
      for (const dep of next?.dependencies ?? []) {
        if (seen.has(dep)) continue;
        seen.add(dep);
        stack.push(dep);
      }
    }
    return seen;
  }

  /** Whether `type`/`name` waits, directly or not, on `onType`/`onName`. */
  waitsOn(type: string, name: string, onType: string, onName: string): boolean {
    this.find(onType, onName);
    return this.closure(type, name).has(urnOf(onType, onName));
  }
}
