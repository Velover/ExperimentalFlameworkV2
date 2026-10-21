# Flamework v2: components

For anything not covered here, read
`node_modules/@flamework-experimental/core/docs/guide/05-components.md`, and
`04-lifecycle-events.md` next to it for the events a component gets.

## Shape

```ts
import { BaseComponent, Component, ComponentMetadata } from "@flamework-experimental/components";
import { OnStart } from "@flamework-experimental/core";

interface Attributes {
	Speed: number;
	Label?: string;
}

@Component({ tag: Tags.Boat, defaults: { Speed: 16 } })
export class Boat
	extends BaseComponent<Attributes, Model & { Seat: VehicleSeat }>
	implements OnStart
{
	private connection?: RBXScriptConnection;

	constructor(
		metadata: ComponentMetadata,
		private readonly boatService: BoatService,
	) {
		super(metadata);
	}

	onStart() {
		this.connection = this.instance.Seat.GetPropertyChangedSignal("Occupant").Connect(() => {});
	}

	override destroy() {
		this.connection?.Disconnect();
		super.destroy();
	}
}
```

- **Registration:** a component exists only when its folder is registered, with
  `.includePlugin(ComponentPlugin.fromPath("src/..."))` in the entry point of each realm that uses
  it.
- **Constructor:** if a component declares one, `metadata: ComponentMetadata` comes first and goes
  to `super(metadata)`. It can inject its realm's providers and `Components`, and other components
  on the same instance, which it then waits for.
- **Tag:** the instance gets the component through its CollectionService tag. Keep a tag that
  other code uses too in one shared module (`Tags.Boat` above). A component without a tag is
  attached only by `Components.addComponent`.
- **Attributes,** the first type argument (`{}` for none), become guards. An instance whose
  attributes fail them gets no component, and an attribute that later changes to a failing value
  removes the component until it is valid again. A `defaults` entry changes both: a missing or
  invalid attribute is set to the default when the component is built, and a later bad value is
  ignored, keeping the last good one.
- **Writing** `this.attributes.Speed = 20` writes the attribute back to the instance, checked by the
  guard. It only works spelled `<component>.attributes.<name> = ...`, not through a local copy.
- **Instance tree,** the second type argument: the class and the children the instance must have.
  An optional child (`Head?: BasePart`) is a compile error: leave it out of the type and use
  `FindFirstChild`.
- **Cleanup:** `BaseComponent.destroy()` only releases its `onAttributeChanged` connections.
  Removing a tag keeps the instance, so disconnect your own connections in `override destroy()`,
  then call `super.destroy()`.
- **Both realms:** one class in a shared folder registered from both entry points, or one class
  per realm with the same tag. The two realms' components never see each other.
- **Where:** by default no component is built under ServerStorage, ReplicatedStorage, StarterPack,
  StarterGui or StarterPlayer, so a tagged template there gets none until it is cloned or moved into
  the world (`ancestorAllowList`/`ancestorBlockList` change this). Moving a tagged instance out of a
  blocked ancestor, or into an allowlisted one, builds its component; moving it in keeps the one it
  has. A `predicate` that refuses a stored instance where it is stored
  (`(instance) => !instance.IsDescendantOf(ServerStorage)`) keeps it from getting one when it moves
  out: a predicate's refusal when the tag is announced is final.
- **Hiding a tagged child:** moving it into storage that stays in the DataModel (a folder in
  ReplicatedStorage) keeps the component it has, and one stored before its tag was announced gets
  its component when it is shown. Under immediate signal behaviour the engine never announces a
  child hidden from the container's constructor, `onInit` or `onStart` as their tree enters the
  DataModel; Flamework weighs it itself a resumption later, so it still gets its component (taken
  down when it leaves the DataModel), but `GetTagged` and your own tag listeners never see it, and
  removing its tag is not announced either. A tagged child that leaves the DataModel and comes back
  hidden that way in one resumption (moved into a container then parented in) keeps the component it
  had, also taken down when it leaves. A hide made by other code or another module during that
  announcement (a container in one module, the child's component in another) is not recovered:
  `task.defer` it, or tag the tree after parenting it. `Parent = nil` removes the child's component
  and builds a new one when it comes back, so its state is lost. A container whose link names that
  child's component is removed when it unparents the child.
- **Timing:** tagged instances get their components once the module has ignited, after every
  provider's `onStart` has run to its first yield. `onInit` runs right after construction; `onStart`
  and the per-frame events (`OnTick`, `OnPhysics`, `OnRender`) work as on providers.

## Reaching components

- Inject `Components` into a provider (`private readonly components: Components`). A provider
  cannot inject a component class, and `Dependency<SomeComponent>()` is a compile error.
- `getComponent<T>(instance)`: exact class only, and it **builds** the component if the instance
  qualifies. Use `getAllComponents<T>()` to observe without building.
- `getComponents<T>`, `getAllComponents<T>`, `onComponentAdded<T>(cb)` and
  `onComponentRemoved<T>(cb)` also accept an interface, or a superclass that carries `@Component`
  itself. A base class without its own decorator is not looked up.
- `onComponentAdded` does not replay the components that already exist. Subscribe in a provider's
  `onStart`, which runs before any tagged instance gets its component.
- `waitForComponent<T>(instance)` returns a Promise; prefer it to polling.
