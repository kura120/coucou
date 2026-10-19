// Everything Coucou lets its assistant see and do, declared in one place:
// each area's file says what it has, and this registers it all. A function of
// the app that no file here declares does not exist for the assistant.

import type { Registry } from "../core/capabilities/types";
import { apps } from "./apps";
import { chat } from "./chat";
import type { AppHost } from "./host";
import { mochi } from "./mochi";
import { music } from "./music";
import { permissions } from "./permissions";
import { pills } from "./pills";
import { recap } from "./recap";
import { services } from "./services";
import { sessions } from "./sessions";
import { settings } from "./settings";
import type { Area } from "./shared";
import { system } from "./system";
import { timer } from "./timer";
import { views } from "./views";
import { wardrobe } from "./wardrobe";
import { web } from "./web";

export type { AppHost } from "./host";

/** The app's areas, in the order a model is shown them. */
export function appAreas(host: AppHost, registry: Pick<Registry, "undo" | "areas" | "get" | "execute" | "lastChange" | "named" | "all">): Area[] {
  const declared = [
    music(host), pills(host), sessions(host), permissions(host), timer(host), apps(host), views(host),
    settings(host), chat(host), wardrobe(host), recap(host), mochi(host), services(host), web(host),
  ];
  const names = new Set(declared.flatMap((area) => area.capabilities.map((c) => c.area)));
  // Coucou's own area is declared last: `more_tools` is told the names of all of them.
  return [...declared, system(host, registry, [...names, "coucou"])];
}

/** Declares every capability and entity source of the app on the registry. */
export function registerApp(registry: Registry, host: AppHost): void {
  for (const area of appAreas(host, registry)) {
    registry.declare(...area.capabilities);
    for (const source of area.sources) registry.entities(source);
  }
}
