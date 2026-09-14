/**
 * A component's instance tree as data, and the watcher that follows it.
 *
 * The transformer writes an `InstanceShape` from the component's instance type: `Model & { Root:
 * Part & { Texture: Texture } }` becomes the classes an instance may be and the children it must
 * have, by name, each with a shape of its own. The runtime checks a shape the way the component
 * reads the tree -- `FindFirstChild` per required name, which is what `this.instance.Root`
 * resolves to -- and watches it one slot at a time, so a change deep in the tree re-resolves the
 * slot it belongs to and touches nothing else. A second child of a required name is neither a
 * mismatch nor the one that is read, so it can come and go without the component noticing.
 */
export interface InstanceShape {
	/** Class names the instance may be, any of them; absent, any Instance will do. */
	isA?: string[];

	/** The children the instance must have, by name. */
	children?: { [name: string]: InstanceShape };

	/** Whether the child may be missing, which only a child that names a component is allowed to be. */
	optional?: boolean;
}

/** A shape's tree, as whoever watches it sees it. */
export interface ShapeWatcher {
	/** Whether the tree has the shape, as it was last resolved. */
	isMet: () => boolean;

	/**
	 * Resolves every slot from the tree again and answers whether it is met. For what no signal
	 * reports: a sibling renamed to a required name while the slot was empty.
	 */
	refresh: () => boolean;

	/** Disconnects everything the watcher holds. */
	release: () => void;
}

function describeClasses(shape: InstanceShape) {
	return shape.isA === undefined || shape.isA.isEmpty() ? "Instance" : shape.isA.join(" or ");
}

function isOneOf(instance: Instance, shape: InstanceShape) {
	if (shape.isA === undefined || shape.isA.isEmpty()) return true;

	for (const className of shape.isA) {
		if (instance.IsA(className as keyof Instances)) return true;
	}

	return false;
}

function describeMissing(path: string, shape: InstanceShape) {
	return `child '${path}' is missing (expected ${describeClasses(shape)})`;
}

function describeClassMismatch(path: string, instance: Instance, shape: InstanceShape) {
	return path === ""
		? `it is a ${instance.ClassName}, expected ${describeClasses(shape)}`
		: `child '${path}' is a ${instance.ClassName}, expected ${describeClasses(shape)}`;
}

/**
 * Why an instance does not have the shape, or nothing when it does: the first mismatch found, named
 * by its path from the instance, `child 'Root.Texture' is missing (expected Texture)`.
 *
 * A child is read with `FindFirstChild`, which is what `this.instance.Root` reads: the first child
 * of that name in the tree's own order.
 */
export function describeShapeMismatch(shape: InstanceShape, instance: Instance, path = ""): string | undefined {
	if (!isOneOf(instance, shape)) {
		return describeClassMismatch(path, instance, shape);
	}

	if (shape.children !== undefined) {
		for (const [key, childShape] of pairs(shape.children)) {
			const name = key as string;
			const childPath = path === "" ? name : `${path}.${name}`;
			const child = instance.FindFirstChild(name);
			if (child === undefined) {
				if (childShape.optional === true) continue;

				return describeMissing(childPath, childShape);
			}

			const reason = describeShapeMismatch(childShape, child, childPath);
			if (reason !== undefined) return reason;
		}
	}

	return undefined;
}

/** Whether an instance has the shape. */
export function checkShape(shape: InstanceShape, instance: Instance) {
	return describeShapeMismatch(shape, instance) === undefined;
}

/**
 * Runs `callback` on a deferred task once per burst of `schedule` calls, and never after `release`.
 * The engine delivers a move's signals together, and the tree is read once for all of them.
 */
export function deferOnce(callback: () => void) {
	let isScheduled = false;
	let isReleased = false;

	return {
		schedule: () => {
			if (isScheduled || isReleased) return;
			isScheduled = true;

			task.defer(() => {
				isScheduled = false;
				if (!isReleased) callback();
			});
		},
		release: () => {
			isReleased = true;
		},
	};
}

/** One required child of a watched instance: what its name resolves to, and why it is unmet if it is. */
interface Slot {
	name: string;
	shape: InstanceShape;
	path: string;

	/** The child the name resolves to, which is the one the component reads. */
	resolved?: Instance;

	/** The child's own watcher, when its shape asks for children of its own. */
	node?: Node;

	/**
	 * The child whose `Name` is followed: the resolved one, and still that one after it has been
	 * renamed away, so that renaming it back is noticed. Dropped once it leaves the parent.
	 */
	watched?: Instance;
	watchedConnection?: RBXScriptConnection;

	/**
	 * Why the slot is unmet on its own account -- the child is missing, or the wrong class -- and
	 * nothing when it is met, or when its node answers for it.
	 */
	reason?: string;
}

/** A watched instance whose shape asks for children. */
interface Node {
	instance: Instance;
	slots: Map<string, Slot>;
	connections: RBXScriptConnection[];
}

function isSlotMet(slot: Slot): boolean {
	if (slot.reason !== undefined) return false;

	return slot.node === undefined || isNodeMet(slot.node);
}

function isNodeMet(node: Node): boolean {
	for (const [, slot] of node.slots) {
		if (!isSlotMet(slot)) return false;
	}

	return true;
}

function unwatchName(node: Node, slot: Slot) {
	if (slot.watched === undefined) return;

	slot.watchedConnection?.Disconnect();
	slot.watched = undefined;
	slot.watchedConnection = undefined;
}

function watchName(node: Node, slot: Slot, child: Instance, changed: () => void) {
	unwatchName(node, slot);

	slot.watched = child;

	// A rename in either direction: the resolved child renamed away, or the one that was resolved
	// renamed back. What the name resolves to now is the whole question.
	slot.watchedConnection = child.GetPropertyChangedSignal("Name").Connect(() => {
		if (slot.resolved === node.instance.FindFirstChild(slot.name)) return;

		resolveSlot(node, slot, changed);
		changed();
	});
}

function releaseNode(node: Node) {
	for (const connection of node.connections) {
		connection.Disconnect();
	}
	node.connections.clear();

	for (const [, slot] of node.slots) {
		if (slot.node !== undefined) {
			releaseNode(slot.node);
			slot.node = undefined;
		}

		unwatchName(node, slot);
	}
}

/**
 * Reads one slot from the tree as it now stands: the child its name resolves to, that child's
 * class, and -- through a node of its own -- the children it has to have in turn.
 */
function resolveSlot(node: Node, slot: Slot, changed: () => void) {
	const child = node.instance.FindFirstChild(slot.name);

	if (child !== slot.resolved) {
		if (slot.node !== undefined) {
			releaseNode(slot.node);
			slot.node = undefined;
		}

		slot.resolved = child;
	}

	if (child !== undefined && slot.watched !== child) {
		watchName(node, slot, child, changed);
	}

	if (child === undefined) {
		slot.reason = slot.shape.optional === true ? undefined : describeMissing(slot.path, slot.shape);
		return;
	}

	if (!isOneOf(child, slot.shape)) {
		slot.reason = describeClassMismatch(slot.path, child, slot.shape);
		return;
	}

	slot.reason = undefined;
	if (slot.node === undefined) {
		slot.node = createNode(child, slot.shape, slot.path, changed);
	}
}

function refreshNode(node: Node, changed: () => void) {
	for (const [, slot] of node.slots) {
		resolveSlot(node, slot, changed);

		if (slot.node !== undefined) {
			refreshNode(slot.node, changed);
		}
	}
}

function createNode(instance: Instance, shape: InstanceShape, path: string, changed: () => void): Node | undefined {
	if (shape.children === undefined) return undefined;

	const node: Node = { instance, slots: new Map(), connections: [] };

	for (const [key, childShape] of pairs(shape.children)) {
		const name = key as string;
		const slot: Slot = { name, shape: childShape, path: path === "" ? name : `${path}.${name}` };
		node.slots.set(name, slot);
		resolveSlot(node, slot, changed);
	}

	// A child arriving matters to the slot of its name, and only when it is what the name now
	// resolves to: an earlier child of the same name stays the one the component reads.
	node.connections.push(
		instance.ChildAdded.Connect((child) => {
			const slot = node.slots.get(child.Name);
			if (slot === undefined) return;
			if (slot.resolved === instance.FindFirstChild(slot.name)) return;

			resolveSlot(node, slot, changed);
			changed();
		}),
	);

	// A child leaving matters only when it is the one a slot resolved to, or was following the
	// name of. A second child of the same name that nothing resolved to can come and go. The
	// slots are asked one by one, because one child can be followed by two of them: the slot it
	// was renamed away from, and the slot whose name it took.
	node.connections.push(
		instance.ChildRemoved.Connect((child) => {
			let wasFollowed = false;

			for (const [, slot] of node.slots) {
				if (slot.watched !== child) continue;

				unwatchName(node, slot);
				resolveSlot(node, slot, changed);
				wasFollowed = true;
			}

			if (wasFollowed) changed();
		}),
	);

	return node;
}

/**
 * Watches an instance for the shape, one slot per required child, and calls `changed` whenever a
 * slot was resolved again. The caller reads `isMet` on a deferred task, so a burst of changes is
 * read once.
 *
 * The instance's own class cannot change, so it is judged once; the children are what moves.
 */
export function watchShape(instance: Instance, shape: InstanceShape, changed: () => void): ShapeWatcher {
	const classReason = isOneOf(instance, shape) ? undefined : describeClassMismatch("", instance, shape);
	let node = classReason === undefined ? createNode(instance, shape, "", changed) : undefined;

	const isMet = () => classReason === undefined && (node === undefined || isNodeMet(node));

	return {
		isMet,
		refresh: () => {
			if (node !== undefined) refreshNode(node, changed);

			return isMet();
		},
		release: () => {
			if (node !== undefined) {
				releaseNode(node);
				node = undefined;
			}
		},
	};
}
