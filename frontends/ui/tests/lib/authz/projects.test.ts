import { describe, expect, test, vi } from "vitest";
import { requireProjectAccess } from "@/lib/authz/projects";
import type { AuthorizedSession } from "@/lib/auth/types";

vi.mock("@/lib/db", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/lib/workos/client", () => ({
  getWorkOS: vi.fn(),
}));

import { getDb } from "@/lib/db";
import { getWorkOS } from "@/lib/workos/client";

const mockGetDb = vi.mocked(getDb);
const mockGetWorkOS = vi.mocked(getWorkOS);

function mockDbSelect(rows: Array<{ organizationId: string }>) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => Promise.resolve(rows)),
        })),
      })),
    })),
  };
}

function mockCheck(results: Record<string, boolean>) {
  return vi.fn(async ({ permissionSlug }: { permissionSlug: string }) => ({
    authorized: results[permissionSlug] ?? false,
  }));
}

function setupWorkOS(checkResults: Record<string, boolean>) {
  const check = mockCheck(checkResults);
  mockGetWorkOS.mockReturnValue({
    authorization: { check },
  } as unknown as ReturnType<typeof getWorkOS>);
  return check;
}

const baseSession: AuthorizedSession = {
  userId: "user-1",
  email: "user@example.com",
  name: null,
  accessToken: "tok",
  organizationId: "org_1",
  organizationMembershipId: "om_1",
  role: "viewer",
  permissions: [],
};

describe("requireProjectAccess", () => {
  test("org admins bypass per-project checks", async () => {
    const result = await requireProjectAccess(
      { ...baseSession, role: "admin" },
      "project-1",
    );

    expect(result).toEqual({ role: "project-admin" });
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockGetWorkOS).not.toHaveBeenCalled();
  });

  test("returns project-viewer for a viewer", async () => {
    mockGetDb.mockReturnValue(
      mockDbSelect([{ organizationId: "org_1" }]) as never,
    );
    const check = setupWorkOS({
      "project:view": true,
      "project:edit": false,
      "project:manage": false,
    });

    const result = await requireProjectAccess(baseSession, "project-1");

    expect(result).toEqual({ role: "project-viewer" });
    expect(check).toHaveBeenCalledWith({
      organizationMembershipId: "om_1",
      permissionSlug: "project:view",
      resourceExternalId: "project-1",
      resourceTypeSlug: "project",
    });
  });

  test("returns project-editor for an editor", async () => {
    mockGetDb.mockReturnValue(
      mockDbSelect([{ organizationId: "org_1" }]) as never,
    );
    setupWorkOS({
      "project:view": true,
      "project:edit": true,
      "project:manage": false,
    });

    const result = await requireProjectAccess(baseSession, "project-1");

    expect(result).toEqual({ role: "project-editor" });
  });

  test("returns project-admin for a project manager", async () => {
    mockGetDb.mockReturnValue(
      mockDbSelect([{ organizationId: "org_1" }]) as never,
    );
    setupWorkOS({
      "project:view": true,
      "project:edit": true,
      "project:manage": true,
    });

    const result = await requireProjectAccess(baseSession, "project-1");

    expect(result).toEqual({ role: "project-admin" });
  });

  test("throws 'Not found' when the user lacks the requested permission", async () => {
    mockGetDb.mockReturnValue(
      mockDbSelect([{ organizationId: "org_1" }]) as never,
    );
    setupWorkOS({
      "project:view": false,
    });

    await expect(
      requireProjectAccess(baseSession, "project-1"),
    ).rejects.toThrow("Not found");
  });

  test("throws 'Not found' for a project outside the current organization", async () => {
    mockGetDb.mockReturnValue(
      mockDbSelect([{ organizationId: "org_2" }]) as never,
    );
    setupWorkOS({});

    await expect(
      requireProjectAccess(baseSession, "project-1"),
    ).rejects.toThrow("Not found");
    expect(mockGetWorkOS).not.toHaveBeenCalled();
  });

  test("throws 'Not found' when the project does not exist", async () => {
    mockGetDb.mockReturnValue(mockDbSelect([]) as never);
    setupWorkOS({});

    await expect(
      requireProjectAccess(baseSession, "project-1"),
    ).rejects.toThrow("Not found");
    expect(mockGetWorkOS).not.toHaveBeenCalled();
  });
});
