--!strict
-- Shared type definitions used across RequireOnRails submodules.

export type ModuleCache = { [string]: ModuleScript }

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
	DisableCache: boolean?,
	-- How ambiguous `@Name` requires resolve: "Nearest" (default) picks the module
	-- with the fewest tree steps from the requirer; "Unique" mirrors the tool's
	-- dynamic mode and errors on duplicate names PathPriority does not resolve.
	SearchMode: ("Nearest" | "Unique")?,
	-- Ordered tie-breakers, highest priority first. A module matches an entry
	-- when it is that Instance or a descendant of it.
	PathPriority: { Instance }?,
}

return {}
