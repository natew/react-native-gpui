import ReactReconciler from "react-reconciler";

// ── Instance types ──────────────────────────────────────────────────

let nextId = 1;
export function genId(): number {
    return nextId++;
}
export function resetIds(): void {
    nextId = 1;
}

export type Instance = {
    id: number;
    type: string;
    props: Record<string, unknown>;
    children: (Instance | TextInstance)[];
};

export type TextInstance = {
    id: number;
    text: string;
};

export type Container = {
    rootID: number;
    children: (Instance | TextInstance)[];
};

// ── Serialization ──────────────────────────────────────────────────

export type SerializedNode = {
    globalId: number;
    type: string;
    style?: Record<string, unknown>;
    text?: string;
    children?: SerializedNode[];
};

function serializeInstance(inst: Instance): SerializedNode {
    return {
        globalId: inst.id,
        type: inst.type,
        style: (inst.props.style as Record<string, unknown>) ?? undefined,
        children: inst.children.map((c) => {
            if ("text" in c && typeof (c as TextInstance).text === "string") {
                return { globalId: c.id, type: "text", text: (c as TextInstance).text };
            }
            return serializeInstance(c as Instance);
        }),
    };
}

/**
 * Serialize the container tree to a JSON-ready object.
 */
export function serializeContainer(container: Container): SerializedNode {
    const children = container.children.map((c) => {
        if ("text" in c && typeof (c as TextInstance).text === "string") {
            return { globalId: c.id, type: "text" as const, text: (c as TextInstance).text };
        }
        return serializeInstance(c as Instance);
    });
    return {
        globalId: container.rootID,
        type: "div" as const,
        style: {
            width: 720,
            height: 800,
            backgroundColor: "#1e1e2e",
            flexDirection: "column",
            padding: 16,
            gap: 8,
        },
        children,
    };
}

// ── Host config ─────────────────────────────────────────────────────

const hostConfig = {
    supportsMutation: true,
    supportsPersistence: false,
    isPrimaryRenderer: true,

    // Creation
    createInstance(
        type: string,
        props: Record<string, unknown>,
        _rootContainer: Container,
        _hostContext: unknown
    ): Instance {
        return { id: genId(), type, props, children: [] };
    },

    createTextInstance(
        text: string,
        _rootContainer: Container,
        _hostContext: unknown
    ): TextInstance {
        return { id: genId(), text };
    },

    // Tree mutation
    appendInitialChild(parent: Instance | Container, child: Instance | TextInstance): void {
        if (!("children" in parent)) return;
        (parent as Instance | Container).children.push(child);
    },

    appendChild(parent: Instance, child: Instance | TextInstance): void {
        parent.children.push(child);
    },

    appendChildToContainer(container: Container, child: Instance | TextInstance): void {
        container.children.push(child);
    },

    removeChild(parent: Instance, child: Instance | TextInstance): void {
        const idx = parent.children.indexOf(child);
        if (idx !== -1) parent.children.splice(idx, 1);
    },

    removeChildFromContainer(container: Container, child: Instance | TextInstance): void {
        const idx = container.children.indexOf(child);
        if (idx !== -1) container.children.splice(idx, 1);
    },

    insertBefore(
        parent: Instance,
        child: Instance | TextInstance,
        before: Instance | TextInstance
    ): void {
        const idx = parent.children.indexOf(before);
        if (idx !== -1) {
            parent.children.splice(idx, 0, child);
        } else {
            parent.children.push(child);
        }
    },

    insertInContainerBefore(
        container: Container,
        child: Instance | TextInstance,
        before: Instance | TextInstance
    ): void {
        const idx = container.children.indexOf(before);
        if (idx !== -1) {
            container.children.splice(idx, 0, child);
        } else {
            container.children.push(child);
        }
    },

    // Updates
    prepareUpdate(
        _instance: Instance,
        _type: string,
        _oldProps: Record<string, unknown>,
        newProps: Record<string, unknown>,
        _rootContainer: Container,
        _hostContext: unknown
    ): Record<string, unknown> | null {
        return newProps;
    },

    commitUpdate(
        instance: Instance,
        _updatePayload: unknown,
        _type: string,
        _prevProps: Record<string, unknown>,
        nextProps: Record<string, unknown>
    ): void {
        instance.props = nextProps;
    },

    commitTextUpdate(textInstance: TextInstance, _oldText: string, newText: string): void {
        textInstance.text = newText;
    },

    // Lifecycle
    finalizeInitialChildren(
        _instance: Instance,
        _type: string,
        _props: Record<string, unknown>,
        _rootContainer: Container,
        _hostContext: unknown
    ): boolean {
        return false;
    },

    shouldSetTextContent(_type: string, _props: Record<string, unknown>): boolean {
        return false;
    },

    // Scheduling
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    noTimeout: -1 as unknown as number,
    now: Date.now,

    // Misc
    getPublicInstance(instance: Instance): Instance {
        return instance;
    },

    getRootHostContext(_rootContainer: Container): Record<string, unknown> {
        return {};
    },

    getChildHostContext(
        _parentHostContext: unknown,
        _type: string,
        _rootContainer: Container
    ): Record<string, unknown> {
        return {};
    },

    prepareForCommit(_container: Container): Record<string, unknown> | null {
        return null;
    },

    resetAfterCommit(_container: Container): void {
        // Tree committed
    },

    preparePortalMount(_container: Container): void {
        // No-op
    },

    shouldYield(): boolean {
        return false;
    },

    scheduleMicrotask(fn: () => void): void {
        Promise.resolve().then(fn);
    },

    clearContainer(container: Container): void {
        container.children = [];
    },
} as const;

// Create the reconciler instance
export type ReconcilerInstance = ReturnType<typeof ReactReconciler>;
const Reconciler = ReactReconciler(hostConfig);

export default Reconciler;
