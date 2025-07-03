-- Authors: Logan Hunt (Raildex)
-- April 16, 2025

--// Services //--
local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local RequireOnRails = require(ReplicatedStorage.src.Packages.RequireOnRails) :: any
local ImportGenerator--: RequireOnRails.ContextualImportGenerator

------------------------------

-- Defines whether or not an instance should be ignored by the import generator.
local ignorePredicate = function(instance: Instance): (boolean)
	local isDescendantOfPackageIndexFolder = instance:IsDescendantOf(ReplicatedStorage.src.Packages._Index)
	local shouldIgnoreFile = isDescendantOfPackageIndexFolder
	return shouldIgnoreFile
end

------------------------------

if RunService:IsClient() then
	ImportGenerator = RequireOnRails({
		Ancestors = {
			["Client"] = ReplicatedStorage.src.Client,
			["Shared"] = ReplicatedStorage.src.Shared,
			["Packages"] = ReplicatedStorage.src.Packages,
		},
		IgnorePredicate = ignorePredicate,
	})
else
	local ServerScriptService = game:GetService("ServerScriptService")
	ImportGenerator = RequireOnRails({
		Ancestors = {
			["Server"] = ServerScriptService.src.Server,
			["Shared"] = ReplicatedStorage.src.Shared,
			["Packages"] = ReplicatedStorage.src.Packages,
			["ServerPackages"] = ServerScriptService.src.ServerPackages,
		},
		IgnorePredicate = ignorePredicate,
	})
end

return ImportGenerator
