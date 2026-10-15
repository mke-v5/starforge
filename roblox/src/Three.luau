--!native
-- Minimal double-precision port of the parts of three.js the Starforge simulation uses.
-- Same names and semantics as three.js (mutating methods return self), so the translated
-- flight code reads line for line like the web version. Roblox's own Vector3 is single
-- precision, which is far too coarse for orbits, so the simulation never uses it.

local M = {}

----------------------------------------------------------------- Vector3
local Vector3 = {}
Vector3.__index = Vector3
M.Vector3 = Vector3

function Vector3.new(x: number?, y: number?, z: number?)
	return setmetatable({ x = x or 0, y = y or 0, z = z or 0 }, Vector3)
end
local V = Vector3.new

function Vector3:set(x, y, z) self.x = x; self.y = y; self.z = z; return self end
function Vector3:clone() return V(self.x, self.y, self.z) end
function Vector3:copy(v) self.x = v.x; self.y = v.y; self.z = v.z; return self end
function Vector3:add(v) self.x += v.x; self.y += v.y; self.z += v.z; return self end
function Vector3:addScalar(s) self.x += s; self.y += s; self.z += s; return self end
function Vector3:addVectors(a, b) self.x = a.x + b.x; self.y = a.y + b.y; self.z = a.z + b.z; return self end
function Vector3:addScaledVector(v, s) self.x += v.x * s; self.y += v.y * s; self.z += v.z * s; return self end
function Vector3:sub(v) self.x -= v.x; self.y -= v.y; self.z -= v.z; return self end
function Vector3:subVectors(a, b) self.x = a.x - b.x; self.y = a.y - b.y; self.z = a.z - b.z; return self end
function Vector3:multiply(v) self.x *= v.x; self.y *= v.y; self.z *= v.z; return self end
function Vector3:multiplyScalar(s) self.x *= s; self.y *= s; self.z *= s; return self end
function Vector3:divideScalar(s) return self:multiplyScalar(1 / s) end
function Vector3:negate() self.x = -self.x; self.y = -self.y; self.z = -self.z; return self end
function Vector3:dot(v) return self.x * v.x + self.y * v.y + self.z * v.z end
function Vector3:lengthSq() return self.x * self.x + self.y * self.y + self.z * self.z end
function Vector3:length() return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z) end
function Vector3:normalize()
	local l = self:length()
	if l == 0 then l = 1 end
	return self:multiplyScalar(1 / l)
end
function Vector3:setLength(l) return self:normalize():multiplyScalar(l) end
function Vector3:distanceTo(v) local dx, dy, dz = self.x - v.x, self.y - v.y, self.z - v.z; return math.sqrt(dx * dx + dy * dy + dz * dz) end
function Vector3:distanceToSquared(v) local dx, dy, dz = self.x - v.x, self.y - v.y, self.z - v.z; return dx * dx + dy * dy + dz * dz end
function Vector3:min(v) self.x = math.min(self.x, v.x); self.y = math.min(self.y, v.y); self.z = math.min(self.z, v.z); return self end
function Vector3:max(v) self.x = math.max(self.x, v.x); self.y = math.max(self.y, v.y); self.z = math.max(self.z, v.z); return self end
function Vector3:clampScalar(a, b)
	self.x = math.clamp(self.x, a, b); self.y = math.clamp(self.y, a, b); self.z = math.clamp(self.z, a, b); return self
end
function Vector3:lerp(v, t) self.x += (v.x - self.x) * t; self.y += (v.y - self.y) * t; self.z += (v.z - self.z) * t; return self end
function Vector3:lerpVectors(a, b, t)
	self.x = a.x + (b.x - a.x) * t; self.y = a.y + (b.y - a.y) * t; self.z = a.z + (b.z - a.z) * t; return self
end
function Vector3:setComponent(i, v) if i == 0 then self.x = v elseif i == 1 then self.y = v else self.z = v end; return self end
function Vector3:getComponent(i) if i == 0 then return self.x elseif i == 1 then return self.y end; return self.z end
function Vector3:cross(v) return self:crossVectors(self, v) end
function Vector3:crossVectors(a, b)
	local ax, ay, az, bx, by, bz = a.x, a.y, a.z, b.x, b.y, b.z
	self.x = ay * bz - az * by; self.y = az * bx - ax * bz; self.z = ax * by - ay * bx
	return self
end
function Vector3:applyQuaternion(q)
	local vx, vy, vz = self.x, self.y, self.z
	local qx, qy, qz, qw = q.x, q.y, q.z, q.w
	local tx = 2 * (qy * vz - qz * vy)
	local ty = 2 * (qz * vx - qx * vz)
	local tz = 2 * (qx * vy - qy * vx)
	self.x = vx + qw * tx + qy * tz - qz * ty
	self.y = vy + qw * ty + qz * tx - qx * tz
	self.z = vz + qw * tz + qx * ty - qy * tx
	return self
end
function Vector3:applyAxisAngle(axis, angle)
	return self:applyQuaternion(M.Quaternion.new():setFromAxisAngle(axis, angle))
end
function Vector3:applyMatrix3(m)
	local x, y, z = self.x, self.y, self.z
	local e = m.elements
	self.x = e[1] * x + e[4] * y + e[7] * z
	self.y = e[2] * x + e[5] * y + e[8] * z
	self.z = e[3] * x + e[6] * y + e[9] * z
	return self
end
function Vector3:applyMatrix4(m)
	local x, y, z = self.x, self.y, self.z
	local e = m.elements
	local w = 1 / (e[4] * x + e[8] * y + e[12] * z + e[16])
	self.x = (e[1] * x + e[5] * y + e[9] * z + e[13]) * w
	self.y = (e[2] * x + e[6] * y + e[10] * z + e[14]) * w
	self.z = (e[3] * x + e[7] * y + e[11] * z + e[15]) * w
	return self
end
function Vector3:fromArray(a, o) o = o or 0; self.x = a[o + 1]; self.y = a[o + 2]; self.z = a[o + 3]; return self end
function Vector3:toArray() return { self.x, self.y, self.z } end
function Vector3:equals(v) return self.x == v.x and self.y == v.y and self.z == v.z end
function Vector3:__tostring() return string.format("(%.3f, %.3f, %.3f)", self.x, self.y, self.z) end

----------------------------------------------------------------- Quaternion
local Quaternion = {}
Quaternion.__index = Quaternion
M.Quaternion = Quaternion

function Quaternion.new(x: number?, y: number?, z: number?, w: number?)
	return setmetatable({ x = x or 0, y = y or 0, z = z or 0, w = w or 1 }, Quaternion)
end
function Quaternion:set(x, y, z, w) self.x = x; self.y = y; self.z = z; self.w = w; return self end
function Quaternion:clone() return Quaternion.new(self.x, self.y, self.z, self.w) end
function Quaternion:copy(q) self.x = q.x; self.y = q.y; self.z = q.z; self.w = q.w; return self end
function Quaternion:identity() return self:set(0, 0, 0, 1) end
function Quaternion:length() return math.sqrt(self.x * self.x + self.y * self.y + self.z * self.z + self.w * self.w) end
function Quaternion:normalize()
	local l = self:length()
	if l == 0 then self.x = 0; self.y = 0; self.z = 0; self.w = 1
	else l = 1 / l; self.x *= l; self.y *= l; self.z *= l; self.w *= l end
	return self
end
function Quaternion:conjugate() self.x = -self.x; self.y = -self.y; self.z = -self.z; return self end
function Quaternion:invert() return self:conjugate() end
function Quaternion:dot(q) return self.x * q.x + self.y * q.y + self.z * q.z + self.w * q.w end
function Quaternion:multiplyQuaternions(a, b)
	local qax, qay, qaz, qaw = a.x, a.y, a.z, a.w
	local qbx, qby, qbz, qbw = b.x, b.y, b.z, b.w
	self.x = qax * qbw + qaw * qbx + qay * qbz - qaz * qby
	self.y = qay * qbw + qaw * qby + qaz * qbx - qax * qbz
	self.z = qaz * qbw + qaw * qbz + qax * qby - qay * qbx
	self.w = qaw * qbw - qax * qbx - qay * qby - qaz * qbz
	return self
end
function Quaternion:multiply(q) return self:multiplyQuaternions(self, q) end
function Quaternion:premultiply(q) return self:multiplyQuaternions(q, self) end
function Quaternion:setFromAxisAngle(axis, angle)
	local h = angle / 2
	local s = math.sin(h)
	self.x = axis.x * s; self.y = axis.y * s; self.z = axis.z * s; self.w = math.cos(h)
	return self
end
function Quaternion:setFromUnitVectors(vFrom, vTo)
	local r = vFrom:dot(vTo) + 1
	local x, y, z, w
	if r < 1e-8 then
		r = 0
		if math.abs(vFrom.x) > math.abs(vFrom.z) then
			x = -vFrom.y; y = vFrom.x; z = 0; w = r
		else
			x = 0; y = -vFrom.z; z = vFrom.y; w = r
		end
	else
		x = vFrom.y * vTo.z - vFrom.z * vTo.y
		y = vFrom.z * vTo.x - vFrom.x * vTo.z
		z = vFrom.x * vTo.y - vFrom.y * vTo.x
		w = r
	end
	self.x = x; self.y = y; self.z = z; self.w = w
	return self:normalize()
end
-- m: Matrix4 (only its rotation part is read; assumed unscaled)
function Quaternion:setFromRotationMatrix(m)
	local te = m.elements
	local m11, m12, m13 = te[1], te[5], te[9]
	local m21, m22, m23 = te[2], te[6], te[10]
	local m31, m32, m33 = te[3], te[7], te[11]
	local trace = m11 + m22 + m33
	if trace > 0 then
		local s = 0.5 / math.sqrt(trace + 1.0)
		self.w = 0.25 / s
		self.x = (m32 - m23) * s
		self.y = (m13 - m31) * s
		self.z = (m21 - m12) * s
	elseif m11 > m22 and m11 > m33 then
		local s = 2.0 * math.sqrt(1.0 + m11 - m22 - m33)
		self.w = (m32 - m23) / s
		self.x = 0.25 * s
		self.y = (m12 + m21) / s
		self.z = (m13 + m31) / s
	elseif m22 > m33 then
		local s = 2.0 * math.sqrt(1.0 + m22 - m11 - m33)
		self.w = (m13 - m31) / s
		self.x = (m12 + m21) / s
		self.y = 0.25 * s
		self.z = (m23 + m32) / s
	else
		local s = 2.0 * math.sqrt(1.0 + m33 - m11 - m22)
		self.w = (m21 - m12) / s
		self.x = (m13 + m31) / s
		self.y = (m23 + m32) / s
		self.z = 0.25 * s
	end
	return self
end
function Quaternion:slerp(qb, t)
	if t == 0 then return self end
	if t == 1 then return self:copy(qb) end
	local x, y, z, w = self.x, self.y, self.z, self.w
	local cosHalf = w * qb.w + x * qb.x + y * qb.y + z * qb.z
	if cosHalf < 0 then
		self.w = -qb.w; self.x = -qb.x; self.y = -qb.y; self.z = -qb.z
		cosHalf = -cosHalf
	else
		self:copy(qb)
	end
	if cosHalf >= 1.0 then self.w = w; self.x = x; self.y = y; self.z = z; return self end
	local sqrSin = 1.0 - cosHalf * cosHalf
	if sqrSin <= 1e-12 then
		local s = 1 - t
		self.w = s * w + t * self.w; self.x = s * x + t * self.x; self.y = s * y + t * self.y; self.z = s * z + t * self.z
		return self:normalize()
	end
	local sinHalf = math.sqrt(sqrSin)
	local halfTheta = math.atan2(sinHalf, cosHalf)
	local ra = math.sin((1 - t) * halfTheta) / sinHalf
	local rb = math.sin(t * halfTheta) / sinHalf
	self.w = w * ra + self.w * rb; self.x = x * ra + self.x * rb; self.y = y * ra + self.y * rb; self.z = z * ra + self.z * rb
	return self
end
function Quaternion:fromArray(a, o) o = o or 0; self.x = a[o + 1]; self.y = a[o + 2]; self.z = a[o + 3]; self.w = a[o + 4]; return self end

----------------------------------------------------------------- Matrix3 (column-major, like three.js)
local Matrix3 = {}
Matrix3.__index = Matrix3
M.Matrix3 = Matrix3

function Matrix3.new()
	return setmetatable({ elements = { 1, 0, 0, 0, 1, 0, 0, 0, 1 } }, Matrix3)
end
-- arguments in row-major order
function Matrix3:set(n11, n12, n13, n21, n22, n23, n31, n32, n33)
	local te = self.elements
	te[1] = n11; te[2] = n21; te[3] = n31
	te[4] = n12; te[5] = n22; te[6] = n32
	te[7] = n13; te[8] = n23; te[9] = n33
	return self
end
function Matrix3:clone()
	local m = Matrix3.new()
	for i = 1, 9 do m.elements[i] = self.elements[i] end
	return m
end
function Matrix3:copy(m) for i = 1, 9 do self.elements[i] = m.elements[i] end; return self end
function Matrix3:setFromMatrix4(m)
	local me = m.elements
	return self:set(me[1], me[5], me[9], me[2], me[6], me[10], me[3], me[7], me[11])
end
function Matrix3:determinant()
	local te = self.elements
	local a, b, c, d, e, f, g, h, i = te[1], te[2], te[3], te[4], te[5], te[6], te[7], te[8], te[9]
	return a * e * i - a * f * h - b * d * i + b * f * g + c * d * h - c * e * g
end
function Matrix3:invert()
	local te = self.elements
	local n11, n21, n31 = te[1], te[2], te[3]
	local n12, n22, n32 = te[4], te[5], te[6]
	local n13, n23, n33 = te[7], te[8], te[9]
	local t11 = n33 * n22 - n32 * n23
	local t12 = n32 * n13 - n33 * n12
	local t13 = n23 * n12 - n22 * n13
	local det = n11 * t11 + n21 * t12 + n31 * t13
	if det == 0 then return self:set(0, 0, 0, 0, 0, 0, 0, 0, 0) end
	local di = 1 / det
	te[1] = t11 * di
	te[2] = (n31 * n23 - n33 * n21) * di
	te[3] = (n32 * n21 - n31 * n22) * di
	te[4] = t12 * di
	te[5] = (n33 * n11 - n31 * n13) * di
	te[6] = (n31 * n12 - n32 * n11) * di
	te[7] = t13 * di
	te[8] = (n21 * n13 - n23 * n11) * di
	te[9] = (n22 * n11 - n21 * n12) * di
	return self
end

----------------------------------------------------------------- Matrix4 (column-major)
local Matrix4 = {}
Matrix4.__index = Matrix4
M.Matrix4 = Matrix4

function Matrix4.new()
	return setmetatable({ elements = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 } }, Matrix4)
end
function Matrix4:set(n11, n12, n13, n14, n21, n22, n23, n24, n31, n32, n33, n34, n41, n42, n43, n44)
	local te = self.elements
	te[1] = n11; te[5] = n12; te[9] = n13; te[13] = n14
	te[2] = n21; te[6] = n22; te[10] = n23; te[14] = n24
	te[3] = n31; te[7] = n32; te[11] = n33; te[15] = n34
	te[4] = n41; te[8] = n42; te[12] = n43; te[16] = n44
	return self
end
function Matrix4:identity() return self:set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1) end
function Matrix4:clone() local m = Matrix4.new(); for i = 1, 16 do m.elements[i] = self.elements[i] end; return m end
function Matrix4:copy(m) for i = 1, 16 do self.elements[i] = m.elements[i] end; return self end
function Matrix4:makeBasis(x, y, z)
	return self:set(x.x, y.x, z.x, 0, x.y, y.y, z.y, 0, x.z, y.z, z.z, 0, 0, 0, 0, 1)
end
function Matrix4:makeScale(x, y, z) return self:set(x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1) end
function Matrix4:compose(position, q, scale)
	local te = self.elements
	local x, y, z, w = q.x, q.y, q.z, q.w
	local x2, y2, z2 = x + x, y + y, z + z
	local xx, xy, xz = x * x2, x * y2, x * z2
	local yy, yz, zz = y * y2, y * z2, z * z2
	local wx, wy, wz = w * x2, w * y2, w * z2
	local sx, sy, sz = scale.x, scale.y, scale.z
	te[1] = (1 - (yy + zz)) * sx; te[2] = (xy + wz) * sx; te[3] = (xz - wy) * sx; te[4] = 0
	te[5] = (xy - wz) * sy; te[6] = (1 - (xx + zz)) * sy; te[7] = (yz + wx) * sy; te[8] = 0
	te[9] = (xz + wy) * sz; te[10] = (yz - wx) * sz; te[11] = (1 - (xx + yy)) * sz; te[12] = 0
	te[13] = position.x; te[14] = position.y; te[15] = position.z; te[16] = 1
	return self
end
function Matrix4:makeRotationFromQuaternion(q)
	return self:compose(V(0, 0, 0), q, V(1, 1, 1))
end
function Matrix4:multiplyMatrices(a, b)
	local ae, be, te = a.elements, b.elements, self.elements
	local r = {}
	for row = 0, 3 do
		for col = 0, 3 do
			local s = 0
			for k = 0, 3 do s += ae[k * 4 + row + 1] * be[col * 4 + k + 1] end
			r[col * 4 + row + 1] = s
		end
	end
	for i = 1, 16 do te[i] = r[i] end
	return self
end
function Matrix4:multiply(m) return self:multiplyMatrices(self, m) end
function Matrix4:premultiply(m) return self:multiplyMatrices(m, self) end

----------------------------------------------------------------- Box3
local Box3 = {}
Box3.__index = Box3
M.Box3 = Box3
function Box3.new()
	return setmetatable({ min = V(math.huge, math.huge, math.huge), max = V(-math.huge, -math.huge, -math.huge) }, Box3)
end
function Box3:expandByPoint(p) self.min:min(p); self.max:max(p); return self end
function Box3:isEmpty() return self.max.x < self.min.x or self.max.y < self.min.y or self.max.z < self.min.z end
function Box3:getSize(out) out = out or V(); return out:subVectors(self.max, self.min) end
function Box3:getCenter(out) out = out or V(); return out:addVectors(self.min, self.max):multiplyScalar(0.5) end

return M
