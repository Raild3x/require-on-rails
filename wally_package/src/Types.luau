--!strict
-- Shared type definitions used across RequireOnRails submodules.

export type ModuleCache = { [string]: ModuleScript }
export type ContextCache = { [Instance]: ModuleCache }

export type Config = {
	-- Maps keys to either an Instance (ancestor root) or a string alias that
	-- expands to another key in the same table, e.g. { Root = game.Workspace, R = "Root" }.
	-- String-valued entries act as short aliases: { R = "Root" } makes @R/Foo resolve as @Root/Foo.
	Aliases: { [string]: Instance | string },
	-- Deprecated: use Aliases instead. Merged into Aliases at create() time for backwards compatibility.
	Ancestors: { [string]: Instance | string }?,
	IgnorePredicate: ((Instance) -> boolean)?,
	Debug: boolean?,
	MaxSearchDepth: number?,
	CaseSensitive: boolean?,
	CircularDependencyDetection: boolean?,
	DisableCache: boolean?,
}

return {}
