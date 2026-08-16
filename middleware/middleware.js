const jwt=require("jsonwebtoken");
const JWT_SECRET=process.env.JWT_SECRET;


module.exports = function auth(req, res, next) {
    let token = req.cookies?.token;
    if (!token && req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
        token = req.headers.authorization.split(" ")[1];
    }
    
    if(!token){
        return res.status(401).json({success:false,message:"Unauthorized"});
    }
    jwt.verify(token,JWT_SECRET,(err,user)=>{
        if(err){
            return res.status(403).json({success:false,message:"Forbidden"});
        }
        req.user=user;
        next();
    });
}