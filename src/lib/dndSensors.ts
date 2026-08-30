import { PointerSensor } from "@dnd-kit/core";
import type { PointerEvent as ReactPointerEvent } from "react";

function targetIsNonDraggable(target: EventTarget | null): boolean {
  let el = target as HTMLElement | null;
  while (el) {
    if (el.dataset?.noDnd === "true") return true;
    el = el.parentElement;
  }
  return false;
}

// Ignores pointerdown events that originate on an element (or a descendant
// of one) marked data-no-dnd="true", e.g. the per-thumbnail tag toggle.
// Stopping propagation on the child isn't reliable on its own with dnd-kit's
// global pointer tracking, so we filter at the sensor's activation check.
export class TagAwarePointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: ReactPointerEvent) => {
        if (nativeEvent.button !== 0) return false;
        if (targetIsNonDraggable(nativeEvent.target)) return false;
        return true;
      },
    },
  ];
}
