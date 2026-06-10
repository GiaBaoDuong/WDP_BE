const { Server } = require("socket.io");

let io = null;

const initSocket = (server) => {
  if (io) return io;

  io = new Server(server, {
    cors: {
      origin: [
        "http://localhost:5173",
        "http://localhost:3000",
        process.env.FRONTEND_DEV_URL,
        process.env.FRONTEND_PROD_URL,
      ].filter(Boolean),
      methods: ["GET", "POST"],
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    console.log("[Socket] Client connected:", socket.id);

    // Client join phòng user riêng để nhận notification
    socket.on("join_user_room", (userId) => {
      socket.join(`user_${userId}`);
      console.log(`[Socket] ${socket.id} joined user_${userId}`);
    });

    // Realtime progress cho studio
    socket.on("join_chapter_room", (chapterId) => {
      socket.join(`chapter_${chapterId}`);
    });

    socket.on("leave_chapter_room", (chapterId) => {
      socket.leave(`chapter_${chapterId}`);
    });

    socket.on("task_progress_update", (data) => {
      // Assistant cập nhật tiến độ làm việc → gửi cho Mangaka
      socket.to(`chapter_${data.chapterId}`).emit("task_progress", data);
    });

    socket.on("disconnect", () => {
      console.log("[Socket] Client disconnected:", socket.id);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error("Socket.io not initialized. Call initSocket first.");
  }
  return io;
};

module.exports = { initSocket, getIO };
