--[=[
    @class SharedAssets

    This file serves as a central point for accessing assets in the project. It allows you to easily 
    reference assets without hardcoding paths throughout your codebase. By using this module, you can 
    maintain a clean and organized structure for your assets, making it easier to manage and update them as needed.
]=]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local AssetsFolder = ReplicatedStorage.src.Assets

return AssetsFolder
