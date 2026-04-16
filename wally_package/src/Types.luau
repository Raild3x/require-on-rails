--!strict
-- Shared type definitions used across RequireOnRails submodules.

export type ModuleCache = { [string]: ModuleScript }
export type ContextCache = { [Instance]: ModuleCache }

export type Config = {
	Ancestors: { [string]: Instance },
	Aliases: { [string]: string }?,
	IgnorePredicate: ((Instance) -> boolean)?,
	Debug: boolean?,
	MaxSearchDepth: number?,
	CaseSensitive: boolean?,
	CircularDependencyDetection: boolean?,
	DisableCache: boolean?,
}

return {}
