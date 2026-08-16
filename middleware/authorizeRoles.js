const ApiError = require("../utils/apiError");

const normalizeRole = (role) => {
    if (!role) return "";
    const lower = role.toLowerCase().replace(/[_-]/g, "");
    if (lower === "attendant" || lower === "attendent") return "attendent";
    if (lower === "chiefwarden") return "chief-warden";
    return lower;
};

const authorizeRoles = (...allowedRoles) => {
    const normalizedAllowed = allowedRoles.map(normalizeRole);

    return (req, res, next) => {
        if (!req.user || !req.user.role) {
            return next(new ApiError(401, "Authentication required"));
        }

        const userRole = normalizeRole(req.user.role);

        if (!normalizedAllowed.includes(userRole)) {
            return next(
                new ApiError(403, `Access denied: Role '${req.user.role}' is not authorized to access this resource`)
            );
        }

        next();
    };
};

module.exports = authorizeRoles;
