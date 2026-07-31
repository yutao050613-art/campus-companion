export interface CampusCatalogItem {
  readonly id: string;
  readonly name: string;
}

export interface RouteCatalogItem {
  readonly id: string;
  readonly campusId: string;
  readonly origin: { readonly id: string; readonly name: string; readonly type: string };
  readonly destination: { readonly id: string; readonly name: string; readonly type: string };
  readonly windows: readonly { readonly start: string; readonly end: string }[];
}

export interface DemandItem {
  readonly id: string;
  readonly routeId: string;
  readonly groupId: string | null;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly seatCount: number;
  readonly status: string;
  readonly createdAt: string;
}

export interface GroupItem {
  readonly id: string;
  readonly campusId: string;
  readonly routeId: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly state: string;
  readonly accountCount: number;
  readonly occupiedSeats: number;
  readonly remainingSeats: number;
  readonly members: readonly {
    readonly memberId: string;
    readonly displayName: string;
    readonly seatCount: number;
    readonly verified: true;
    readonly joinedAt: string;
  }[];
  readonly activeRoundId: string | null;
  readonly version: number;
}

export interface FormationItem {
  readonly id: string;
  readonly groupId: string;
  readonly state: string;
  readonly memberCount: number;
  readonly memberSnapshotHash: string;
  readonly contactPolicyVersion: string;
  readonly confirmBy: string;
  readonly payBy: string | null;
  readonly createdAt: string;
}

export function localIsoDate(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function routeLabel(route: RouteCatalogItem): string {
  return `${route.origin.name} → ${route.destination.name}`;
}

export function windowLabel(window: { readonly start: string; readonly end: string }): string {
  const start = new Date(window.start);
  const end = new Date(window.end);
  return `${two(start.getHours())}:${two(start.getMinutes())}—${two(end.getHours())}:${two(end.getMinutes())}`;
}

function two(value: number): string {
  return String(value).padStart(2, "0");
}
