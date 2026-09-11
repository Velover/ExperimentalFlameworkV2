// Deliberately empty. A game lists the scope in its typeRoots, and TypeScript then treats every
// package in that directory as a type library to include: this file is what it finds here, so
// the transformer's own declarations (typescript and all) never enter a place's program.
export {};
