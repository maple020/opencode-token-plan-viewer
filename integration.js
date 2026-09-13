export const QUOTA_SIDEBAR_ORDER = 910;
export const MODEL_USAGE_SIDEBAR_ORDER = 920;

function derive(source, overrides) {
  const descriptors = Object.getOwnPropertyDescriptors(source);

  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if ("value" in descriptor) {
      if (typeof descriptor.value === "function") descriptor.value = descriptor.value.bind(source);
    } else {
      if (descriptor.get) descriptor.get = descriptor.get.bind(source);
      if (descriptor.set) descriptor.set = descriptor.set.bind(source);
    }
  }

  for (const key of Reflect.ownKeys(overrides)) {
    const descriptor = descriptors[key];
    descriptors[key] = {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      writable: descriptor && "writable" in descriptor ? descriptor.writable : Boolean(descriptor?.set),
      value: Reflect.get(overrides, key, overrides),
    };
  }

  return Object.create(Object.getPrototypeOf(source), descriptors);
}

function isSidebarRegistration(registration) {
  if (!registration || (typeof registration !== "object" && typeof registration !== "function")) {
    return false;
  }
  const slots = Reflect.get(registration, "slots", registration);
  return Boolean(slots) && Reflect.ownKeys(slots).some(
    (name) => typeof name === "string" && name.startsWith("sidebar_"),
  );
}

function withOrder(registration, order) {
  const descriptors = Object.getOwnPropertyDescriptors(registration);
  const descriptor = descriptors.order;
  descriptors.order = {
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? true,
    writable: descriptor && "writable" in descriptor ? descriptor.writable : Boolean(descriptor?.set),
    value: order,
  };
  return Object.create(Object.getPrototypeOf(registration), descriptors);
}

export function createUpstreamTuiApi(api) {
  const slots = Reflect.get(api, "slots", api);
  const register = Reflect.get(slots, "register", slots);
  if (typeof register !== "function") throw new TypeError("TUI api.slots.register must be a function");

  const forwardedSlots = derive(slots, {
    register(registration, ...rest) {
      const forwarded = isSidebarRegistration(registration)
        ? withOrder(registration, QUOTA_SIDEBAR_ORDER)
        : registration;
      return Reflect.apply(register, slots, [forwarded, ...rest]);
    },
  });

  return derive(api, { slots: forwardedSlots });
}
