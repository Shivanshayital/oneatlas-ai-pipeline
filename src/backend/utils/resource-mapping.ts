import { ApiEndpoint, DataEntity, Page } from "../types";

type PageMappingCandidate = Pick<Page, "name" | "path">;
type EndpointMappingCandidate = Pick<ApiEndpoint, "path" | "entity">;

const PAGE_NAME_SUFFIXES = ["details", "detail", "page", "view"];

export function hasMatchingPageEndpoint(
  page: PageMappingCandidate,
  endpoint: EndpointMappingCandidate
): boolean {
  const pagePath = normalizeRoutePath(page.path ?? "");
  const endpointPath = normalizeRoutePath(endpoint.path ?? "");

  if (pagePath && endpointPath) {
    const apiPagePath = normalizeRoutePath(`/api${pagePath === "/" ? "" : pagePath}`);
    if (
      endpointPath === pagePath ||
      endpointPath === apiPagePath ||
      endpointPath.startsWith(`${apiPagePath}/`) ||
      routePatternsShareEntity(pagePath, endpointPath)
    ) {
      return true;
    }
  }

  const pageKeys = buildResourceMatchKeys([page.name, page.path ?? ""]);
  const endpointKeys = buildResourceMatchKeys([endpoint.entity ?? "", endpoint.path ?? ""]);

  for (const key of pageKeys) {
    if (endpointKeys.has(key)) return true;
  }

  return false;
}

export function inferEntityForPage(page: PageMappingCandidate, entities: DataEntity[]): DataEntity | undefined {
  const pageKeys = buildResourceMatchKeys([page.name, page.path ?? ""]);
  return entities.find((entity) => {
    const entityKeys = buildResourceMatchKeys([entity.name, entity.tableName]);
    for (const key of pageKeys) {
      if (entityKeys.has(key)) return true;
    }
    return false;
  });
}

export function buildDetailEndpointForEntity(entity: DataEntity): string {
  const tableName = normalizeRouteSegment(entity.tableName) || pluralizeResource(normalizeRouteSegment(entity.name));
  const paramName = `${lowerCamel(entity.name)}Id`;
  return `/api/${tableName}/:${paramName}`;
}

function routePatternsShareEntity(pagePath: string, endpointPath: string): boolean {
  const pageSegments = routeResourceSegments(pagePath);
  const endpointSegments = routeResourceSegments(endpointPath);
  return pageSegments.some((pageSegment) =>
    endpointSegments.some((endpointSegment) => resourcesEquivalent(pageSegment, endpointSegment))
  );
}

function buildResourceMatchKeys(values: string[]): Set<string> {
  const keys = new Set<string>();

  for (const value of values) {
    for (const token of resourceTokens(value)) {
      const normalized = normalizeResourceName(token);
      if (!normalized) continue;

      // Page names are probabilistic LLM output. Generate exact, singular, and
      // plural keys so "taskdetail", "tasks-page", and "/tasks/:taskId" can all
      // map to entity/path forms such as "Task", "tasks", or "/api/tasks/:taskId".
      keys.add(normalized);
      keys.add(singularizeResource(normalized));
      keys.add(pluralizeResource(normalized));
    }
  }

  return keys;
}

function resourceTokens(value: string): string[] {
  const routeSegments = routeResourceSegments(value);
  const words = value
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return [...routeSegments, ...words, value];
}

function routeResourceSegments(path: string): string[] {
  return normalizeRoutePath(path)
    .split("/")
    .filter((segment) => segment && segment !== "api")
    .map((segment) => segment.replace(/^:/, ""))
    .map(stripIdentifierSuffix)
    .filter((segment) => segment.length > 0);
}

function normalizeResourceName(value: string): string {
  let normalized = stripIdentifierSuffix(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  // Detail/page/view suffixes describe UI shape rather than data ownership.
  // Removing them lets names like "taskdetail" match dynamic REST endpoints.
  let didStrip = true;
  while (didStrip) {
    didStrip = false;
    for (const suffix of PAGE_NAME_SUFFIXES) {
      if (normalized.length > suffix.length && normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length);
        didStrip = true;
      }
    }
  }

  return normalized;
}

function resourcesEquivalent(left: string, right: string): boolean {
  const leftName = normalizeResourceName(left);
  const rightName = normalizeResourceName(right);
  if (!leftName || !rightName) return false;
  return (
    leftName === rightName ||
    singularizeResource(leftName) === singularizeResource(rightName) ||
    pluralizeResource(leftName) === pluralizeResource(rightName)
  );
}

function stripIdentifierSuffix(value: string): string {
  return value.replace(/id$/i, "");
}

function singularizeResource(value: string): string {
  if (value.endsWith("ies") && value.length > 3) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses") && value.length > 3) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 1) return value.slice(0, -1);
  return value;
}

function pluralizeResource(value: string): string {
  if (value.endsWith("y") && value.length > 1) return `${value.slice(0, -1)}ies`;
  if (value.endsWith("s")) return value;
  return `${value}s`;
}

function normalizeRoutePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/+/g, "/").replace(/\/$/g, "") || "/";
}

function normalizeRouteSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function lowerCamel(value: string): string {
  const words = value
    .split(/[^a-zA-Z0-9]+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 0);
  const [first, ...rest] = words.length > 0 ? words : [value];
  return [
    first.charAt(0).toLowerCase() + first.slice(1),
    ...rest.map((word) => word.charAt(0).toUpperCase() + word.slice(1)),
  ].join("");
}
