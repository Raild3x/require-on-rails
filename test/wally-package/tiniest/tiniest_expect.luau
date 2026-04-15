-- From dphfox/tiniest, licenced under BSD
--!strict

--[=[
	@class TiniestExpect
	
	Provides assertion methods for testing. All assertions return the expectation object,
	allowing for method chaining.
	
	## Example Usage
	```lua
	local expect = require(path.to.tiniest_expect).expect
	
	-- Basic equality
	expect(5).is(5)
	expect("hello").is("hello")
	
	-- Type checking
	expect(myValue).is_a("number")
	expect(myFunction).is_a("function")
	
	-- Existence checking
	expect(myValue).exists()
	expect(nil).never_exists()
	
	-- Boolean assertions
	expect(true).is_true()
	expect(false).never_is_true()
	
	-- Table/userdata assertions
	expect(myTable).has_key("Health")
	expect(myTable).has_value(100)
	expect(myTable).never_has_key("InvalidKey")
	
	-- Function assertions
	expect(function() error("fail") end).fails()
	expect(function() error("specific error") end).fails_with("specific")
	expect(function() return true end).never_fails()
	```
]=]

local tiniest_quote = require("./tiniest_quote")

local tiniest_expect = {}

type Context = {
	target: unknown,
	test: string,
	params: { unknown },
}

local context: Context = {
	target = nil,
	test = "",
	params = {},
}

local function fail(message: string?): never
	local quoted = {}
	for index, param in context.params do
		quoted[index] = tiniest_quote(param)
	end
	local param_list = table.concat(quoted, ",")
	local source, line = debug.info(4, "sl")
	error({
		type = "tiniest.ErrorReport",
		line = line,
		source = source,
		message = "Expectation not met" .. if message == nil then "" else `, because:\n{message}`,
		trace = debug.traceback(nil, 11), -- This is the traceback when an expectation fails
		code = {
			snippet = `expect({tiniest_quote(context.target)}).{context.test}({param_list})`,
			line = line,
		},
	}, 0)
end

local function check(condition: boolean, cause: string): ()
	if not condition then
		error(`Bad usage of expect().{context.test}()\nCause: {cause}`, 0)
	end
end

local function is_indexable(x: unknown): boolean
	return type(x) == "table" or type(x) == "userdata"
end

--[=[
	Creates an expectation object for the given value with chainable assertion methods.
	
	@param a any -- The value to create assertions for
	@return table -- An expectation object with assertion methods
	
	## Available Assertions
	
	### Existence
	- `.exists()` -- Asserts the value is not nil
	- `.never_exists()` -- Asserts the value is nil
	
	### Equality
	- `.is(b)` -- Asserts the value equals b using == comparison
	- `.never_is(b)` -- Asserts the value does not equal b
	
	### Boolean
	- `.is_true()` -- Asserts the value is true (must be boolean type)
	- `.never_is_true()` -- Asserts the value is false (must be boolean type)
	
	### Type Checking
	- `.is_a(type)` -- Asserts the value's typeof() matches the given type string
	- `.never_is_a(type)` -- Asserts the value's typeof() does not match
	
	### Table/Userdata
	- `.has_key(key)` -- Asserts the table/userdata has the given key
	- `.never_has_key(key)` -- Asserts the table/userdata does not have the key
	- `.has_value(value)` -- Asserts the table contains the value (uses table.find)
	- `.never_has_value(value)` -- Asserts the table does not contain the value
	
	### Functions
	- `.fails()` -- Asserts the function throws an error when called
	- `.never_fails()` -- Asserts the function does not throw an error
	- `.fails_with(message)` -- Asserts the function fails with an error containing the message (case-insensitive)
	- `.never_fails_with(message)` -- Asserts the function doesn't fail with the message
	
	## Examples
	```lua
	-- Chain multiple assertions
	expect(myPlayer).exists().is_a("Instance")
	
	-- Test function behavior
	expect(function() 
		return MyModule.DivideByZero(10, 0) 
	end).fails_with("cannot divide")
	
	-- Test table contents
	expect(inventory).has_key("Gold").has_value(100)
	```
]=]
function tiniest_expect.expect(a: any)
	local tests = {}

	local function check_type(expectedType: string, value: any, msg: string?): ()
		if msg ~= nil then
			msg ..= ": "
		end
		check(
			typeof(value) == expectedType,
			`{msg or ""}Expected type '{expectedType}' but got type '{typeof(value)}' for value: {tiniest_quote(value)}`
		)
	end

	function tests.exists()
		return if a ~= nil then tests else fail()
	end

	function tests.never_exists()
		return if a == nil then tests else fail()
	end

	function tests.is(b: any)
		return if a == b then tests else fail(`Got '{tiniest_quote(a)}' but expected it to be '{tiniest_quote(b)}'`)
	end

	function tests.is_not(b: any)
		return if a ~= b then tests else fail(`Got '{tiniest_quote(a)}' but expected it to not be '{tiniest_quote(b)}'`)
	end

	function tests.never_is(b: any)
		return if a ~= b then tests else fail(`Got '{tiniest_quote(a)}' but expected it to not be '{tiniest_quote(b)}'`)
	end

	function tests.is_shallow_equal(b: { [any]: any })
		check(typeof(a) == "table", "expect() value must be a table")
		check(typeof(b) == "table", "is_shallow_equal() value must be a table")
		local failureReasons = {}
		local checkedKeys = {}
		for k, v in a do
			if b[k] ~= v then
				table.insert(
					failureReasons,
					`Key [{tiniest_quote(k)}] is not equivalent. Got {tiniest_quote(v)} and {tiniest_quote(b[k])}.`
				)
			end
			checkedKeys[k] = true
		end
		for k, v in b do
			if a[k] ~= v and checkedKeys[k] ~= true then
				table.insert(
					failureReasons,
					`Key [{tiniest_quote(k)}] is not equivalent. Got {tiniest_quote(a[k])} and {tiniest_quote(v)}.`
				)
			end
		end
		return if #failureReasons == 0 then tests else fail(table.concat(failureReasons, "\n"))
	end

	function tests.is_deep_equal(b: { [any]: any })
		check(typeof(a) == "table", "expect() value must be a table")
		check(typeof(b) == "table", "is_deep_equal() value must be a table")
		local failureReasons = {}
		local checkedKeys = {}
		local function deep_check(a: any, b: any, path: string)
			for k, v in a do
				local new_path = path .. "[" .. tiniest_quote(k) .. "]"
				checkedKeys[new_path] = true

				if typeof(v) == "table" and typeof(b[k]) == "table" then
					deep_check(v, b[k], new_path)
				elseif b[k] ~= v then
					table.insert(
						failureReasons,
						`Key {new_path} is not equivalent. Got {tiniest_quote(v)} and {tiniest_quote(b[k])}.`
					)
				end
			end
			for k, v in b do
				local new_path = path .. "[" .. tiniest_quote(k) .. "]"
				if checkedKeys[new_path] ~= true and a[k] ~= v then
					table.insert(
						failureReasons,
						`Key {new_path} is not equivalent. Got {tiniest_quote(a[k])} and {tiniest_quote(v)}.`
					)
				end
			end
		end

		deep_check(a, b, "")
		return if #failureReasons == 0 then tests else fail(table.concat(failureReasons, "\n"))
	end

	function tests.is_true()
		check_type("boolean", a, "is_true()")
		return if a then tests else fail()
	end

	function tests.never_is_true()
		check_type("boolean", a, "never_is_true()")
		return if not a then tests else fail()
	end

	function tests.is_a(b: string)
		return if typeof(a) == b
			then tests
			else fail(
				`Expected '{tiniest_quote(a)}' to be type of '{tiniest_quote(b)}'. Got typeof '{tiniest_quote(a)}' instead.`
			)
	end

	function tests.never_is_a(b: string)
		return if typeof(a) ~= b
			then tests
			else fail(`Expected '{tiniest_quote(a)}' to not be type of '{tiniest_quote(b)}'`)
	end

	function tests.has_key(b: any)
		check(is_indexable(a), "expect() value must be indexable")
		check(b ~= nil, "key cannot be nil")
		return if a[b] then tests else fail()
	end

	function tests.never_has_key(b: any)
		check(is_indexable(a), "expect() value must be indexable")
		check(b ~= nil, "key cannot be nil")
		return if not a[b] then tests else fail(`[{tiniest_quote(b)}] = {tiniest_quote(a[b])}`)
	end

	function tests.has_value(b: any)
		check(typeof(a) == "table", "expect() value must be table")
		check(b ~= nil, "value cannot be nil")
		return if table.find(a, b) then tests else fail()
	end

	function tests.never_has_value(b: any)
		check(typeof(a) == "table", "expect() value must be table")
		check(b ~= nil, "value cannot be nil")
		local index = table.find(a, b)
		return if index == nil then tests else fail(`Found at index {index}`)
	end

	function tests.fails()
		check(typeof(a) == "function", "expect() value must be function")
		local ok = pcall(a)
		return if not ok then tests else fail()
	end

	function tests.never_fails()
		check(typeof(a) == "function", "expect() value must be function")
		local ok, err = pcall(a)
		return if ok then tests else fail(`Failed with {tiniest_quote(err)}`)
	end

	function tests.fails_with(b: string)
		check(typeof(a) == "function", "expect() value must be function")
		local ok, err = pcall(a)
		return if not ok and err:lower():match(b:lower())
			then tests
			else if ok then fail("Did not fail") else fail(`Failed with {tiniest_quote(err)}`)
	end

	function tests.never_fails_with(b: string)
		check(typeof(a) == "function", "expect() value must be function")
		local ok, err = pcall(a)
		return if ok or not err:lower():match(b:lower()) then tests else fail()
	end

	function tests.is_greater_than(b: number)
		check(typeof(a) == "number", "expect() value must be a number")
		check(typeof(b) == "number", "is_greater_than() value must be a number")
		return if a > b
			then tests
			else fail(`Got {tiniest_quote(a)} but expected it to be greater than {tiniest_quote(b)}`)
	end

	function tests.is_less_than(b: number)
		check(typeof(a) == "number", "expect() value must be a number")
		check(typeof(b) == "number", "is_less_than() value must be a number")
		return if a < b
			then tests
			else fail(`Got {tiniest_quote(a)} but expected it to be less than {tiniest_quote(b)}`)
	end

	function tests.is_greater_or_equal_to(b: number)
		check(typeof(a) == "number", "expect() value must be a number")
		check(typeof(b) == "number", "value must be a number")
		return if a >= b
			then tests
			else fail(`Got {tiniest_quote(a)} but expected it to be greater than or equal to {tiniest_quote(b)}`)
	end

	function tests.is_less_or_equal_to(b: number)
		check(typeof(a) == "number", "expect() value must be a number")
		check(typeof(b) == "number", "value must be a number")
		return if a <= b
			then tests
			else fail(`Got {tiniest_quote(a)} but expected it to be less than or equal to {tiniest_quote(b)}`)
	end

	for name: any, body: any in tests do
		tests[name] = function(...)
			context.target = a
			context.test = name
			context.params = { ... }
			return body(...)
		end
	end

	return tests
end

export type expect = typeof(tiniest_expect.expect)

return tiniest_expect
