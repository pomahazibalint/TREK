export const SCOPE_DEFINITIONS: Record<string, { label: string; description: string; group: string }> = {
  'trips:read':          { label: 'View trips & itineraries',        group: 'Trips',         description: 'Read trip details, days, and itinerary items' },
  'trips:write':         { label: 'Create & edit trips',             group: 'Trips',         description: 'Create, update trips, days, and assignments' },
  'trips:delete':        { label: 'Delete trips',                    group: 'Trips',         description: 'Permanently delete trips' },
  'trips:share':         { label: 'Create share links',              group: 'Trips',         description: 'Generate public read-only share links for trips' },
  'places:read':         { label: 'View places',                     group: 'Places',        description: 'Read place details and search results' },
  'places:write':        { label: 'Add & edit places',               group: 'Places',        description: 'Create, update, and delete places in trips' },
  'atlas:read':          { label: 'View atlas (visited & bucket list)', group: 'Atlas',      description: 'Read visited countries and bucket list' },
  'atlas:write':         { label: 'Update atlas',                    group: 'Atlas',         description: 'Mark countries visited and manage bucket list' },
  'packing:read':        { label: 'View packing lists',              group: 'Packing',       description: 'Read packing items and categories' },
  'packing:write':       { label: 'Manage packing lists',            group: 'Packing',       description: 'Create, update, toggle, and delete packing items' },
  'todos:read':          { label: 'View to-do lists',                group: 'Todos',         description: 'Read trip to-do items' },
  'todos:write':         { label: 'Manage to-do lists',              group: 'Todos',         description: 'Create, update, and delete to-do items' },
  'budget:read':         { label: 'View budget',                     group: 'Budget',        description: 'Read budget items and expense summaries' },
  'budget:write':        { label: 'Manage budget',                   group: 'Budget',        description: 'Create, update, and delete budget items' },
  'reservations:read':   { label: 'View reservations',               group: 'Reservations',  description: 'Read reservation details and booking info' },
  'reservations:write':  { label: 'Manage reservations',             group: 'Reservations',  description: 'Create, update, and delete reservations' },
  'collab:read':         { label: 'View collaboration notes',        group: 'Collab',        description: 'Read collab notes and day notes' },
  'collab:write':        { label: 'Manage collaboration notes',      group: 'Collab',        description: 'Create, update, and delete collab and day notes' },
  'notifications:read':  { label: 'View notifications',              group: 'Notifications', description: 'Read notification list' },
  'notifications:write': { label: 'Manage notification preferences', group: 'Notifications', description: 'Update notification preferences' },
  'vacay:read':          { label: 'View vacation plans',             group: 'Vacay',         description: 'Read vacation entries and calendars' },
  'vacay:write':         { label: 'Manage vacation plans',           group: 'Vacay',         description: 'Create, update, and delete vacation entries' },
  'geo:read':            { label: 'Geocoding & search',              group: 'Geo',           description: 'Search places and geocode addresses' },
  'weather:read':        { label: 'Weather forecasts',               group: 'Weather',       description: 'Read weather forecast data' },
};

export const ALL_SCOPES = Object.keys(SCOPE_DEFINITIONS);

/** null = full access (static token or JWT); string[] = scoped OAuth token */
export const can = (scopes: string[] | null, scope: string): boolean => {
  _probeCollector?.add(scope);
  return scopes === null || scopes.includes(scope);
};

// When set, can() records every scope it is asked about (probe mode).
let _probeCollector: Set<string> | null = null;

/**
 * Run fn() in probe mode: can() records every scope name it is called with
 * (and still returns true so every guarded block executes), then returns the
 * collected set. Used by implementedScopes.ts to derive IMPLEMENTED_SCOPES
 * dynamically from the actual registrar functions.
 */
export function collectScopesFromRegistration(fn: () => void): string[] {
  const collector = new Set<string>();
  _probeCollector = collector;
  try {
    fn();
  } finally {
    _probeCollector = null;
  }
  return Array.from(collector);
}
