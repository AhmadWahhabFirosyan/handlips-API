require("dotenv").config();
const express = require("express");
const { Sequelize, DataTypes } = require("sequelize");
const textToSpeech = require("@google-cloud/text-to-speech");
const { Storage } = require("@google-cloud/storage");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const multer = require("multer");
const cors = require("cors");

// Initialize express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database setup with Sequelize
const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASSWORD,
  {
    host: process.env.DB_HOST,
    dialect: "mysql",
    logging: false,
    pool: {
      max: 10,
      min: 0,
      acquire: 30000,
      idle: 10000,
    },
  }
);

// Model definitions
const Soundboard = sequelize.define("Soundboard", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  text: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  audioUrl: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  fileName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
});

// Google Cloud Setup
const storage = new Storage({
  keyFilename: "D:/Handlips REST API/gcp-key.json",
  projectId: process.env.GCP_PROJECT_ID,
});

const bucket = storage.bucket(process.env.GCP_BUCKET_NAME);

const ttsClient = new textToSpeech.TextToSpeechClient({
  keyFilename: "D:/Handlips REST API/gcp-key.json",
});

// Multer configuration for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const allowedMimes = ["image/jpeg", "image/png", "image/jpg"];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("File harus berupa gambar."));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
  },
});

// Helper Functions
const generateSpeech = async (text) => {
  try {
    const request = {
      input: { text },
      voice: { languageCode: "id-ID", ssmlGender: "NEUTRAL" },
      audioConfig: { audioEncoding: "MP3" },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    return response.audioContent;
  } catch (error) {
    throw new Error(`Error generating speech: ${error.message}`);
  }
};

const uploadToGCS = async (buffer, filename, contentType = "audio/mpeg") => {
  const file = bucket.file(filename);

  try {
    await file.save(buffer, {
      contentType: contentType,
      metadata: {
        cacheControl: "public, max-age=31536000",
      },
    });

    const publicUrl = `https://storage.googleapis.com/${process.env.GCP_BUCKET_NAME}/${filename}`;
    return publicUrl;
  } catch (error) {
    throw new Error(
      `Error uploading to Google Cloud Storage: ${error.message}`
    );
  }
};

// API ROUTES

// Soundboard Routes
app.post("/soundboards", async (req, res) => {
  try {
    const { text } = req.body;

    if (!text) {
      return res.status(400).json({ error: "Text is required" });
    }

    console.log("Generating speech for text:", text);
    const audioBuffer = await generateSpeech(text);

    const fileName = `${uuidv4()}.mp3`;
    console.log("Uploading to Cloud Storage with filename:", fileName);
    const audioUrl = await uploadToGCS(audioBuffer, fileName);

    console.log("Creating database entry");
    const soundboard = await Soundboard.create({
      text,
      audioUrl,
      fileName,
    });

    res.status(201).json({
      success: true,
      message: "Soundboard created successfully",
      data: soundboard,
    });
  } catch (error) {
    console.error("Error creating soundboard:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create soundboard",
    });
  }
});

app.get("/soundboards", async (req, res) => {
  try {
    const soundboards = await Soundboard.findAll({
      order: [["createdAt", "DESC"]],
    });

    res.json({
      success: true,
      message: "Soundboards retrieved successfully",
      data: soundboards,
    });
  } catch (error) {
    console.error("Error fetching soundboards:", error);
    res.status(500).json({
      success: false,
      error: "Failed to fetch soundboards",
    });
  }
});

app.delete("/soundboards/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Cari soundboard berdasarkan ID
    const soundboard = await Soundboard.findByPk(id);
    if (!soundboard) {
      return res.status(404).json({
        success: false,
        message: "Soundboard tidak ditemukan",
      });
    }

    // Hapus file audio dari Google Cloud Storage
    const filename = soundboard.audioUrl.split("/").pop(); // Ambil nama file dari URL
    const file = bucket.file(filename);

    try {
      await file.delete();
      console.log(`File ${filename} berhasil dihapus dari Cloud Storage`);
    } catch (error) {
      console.error(
        `Gagal menghapus file ${filename} dari Cloud Storage:`,
        error.message
      );
      // Tidak perlu menghentikan proses jika file tidak ditemukan
    }

    // Hapus soundboard dari database
    await soundboard.destroy();

    res.json({
      success: true,
      message: "Soundboard berhasil dihapus",
    });
  } catch (error) {
    console.error("Error deleting soundboard:", error);
    res.status(500).json({
      success: false,
      message: "Gagal menghapus soundboard",
    });
  }
});

// History Routes
app.post("/history", async (req, res) => {
  try {
    const { title, message } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "Judul dan pesan harus diisi",
      });
    }

    const [result] = await sequelize.query(
      "INSERT INTO history (title, message) VALUES (?, ?)",
      {
        replacements: [title, message],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    res.status(201).json({
      success: true,
      data: {
        id: result,
        title,
        message,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/history", async (req, res) => {
  try {
    const [histories] = await sequelize.query(
      "SELECT * FROM history ORDER BY created_at DESC",
      { type: Sequelize.QueryTypes.SELECT }
    );

    res.json({
      success: true,
      data: histories,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/history/:id", async (req, res) => {
  try {
    const [history] = await sequelize.query(
      "SELECT * FROM history WHERE id = ?",
      {
        replacements: [req.params.id],
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (!history) {
      return res.status(404).json({
        success: false,
        message: "Tidak memiliki akses",
      });
    }

    res.json({
      success: true,
      data: history,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Profile Routes
app.post("/profile", upload.single("profile_picture"), async (req, res) => {
  try {
    const { name } = req.body;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    let profilePictureUrl = null;

    // Jika file gambar disertakan, upload ke Google Cloud Storage
    if (req.file) {
      const filename = `profiles/${Date.now()}-${req.file.originalname}`;
      profilePictureUrl = await uploadToGCS(
        req.file.buffer,
        filename,
        req.file.mimetype
      );
    }

    // Cek apakah sudah ada profil
    const [existingProfile] = await sequelize.query(
      "SELECT * FROM profile LIMIT 1",
      {
        type: Sequelize.QueryTypes.SELECT,
      }
    );

    if (existingProfile) {
      return res.status(400).json({
        success: false,
        message: "Profile already exists. Use PUT to update.",
      });
    }

    // Buat profil baru
    await sequelize.query(
      "INSERT INTO profile (name, profile_picture_url) VALUES (?, ?)",
      {
        replacements: [name, profilePictureUrl],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    res.status(201).json({
      success: true,
      message: "Profile created successfully",
      data: {
        name,
        profile_picture_url: profilePictureUrl,
      },
    });
  } catch (error) {
    console.error("Error creating profile:", error);
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.get("/profile", async (req, res) => {
  try {
    const [profile] = await sequelize.query("SELECT * FROM profile LIMIT 1", {
      type: Sequelize.QueryTypes.SELECT,
    });

    if (!profile) {
      return res.status(404).json({
        success: false,
        message: "Profil tidak ditemukan",
      });
    }

    res.json({
      success: true,
      data: profile,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.put("/profile", upload.single("profile_picture"), async (req, res) => {
  try {
    const { name } = req.body;
    let profilePictureUrl = null;

    if (!name) {
      return res.status(400).json({
        success: false,
        message: "Name is required",
      });
    }

    if (req.file) {
      const filename = `profiles/${Date.now()}-${req.file.originalname}`;
      profilePictureUrl = await uploadToGCS(
        req.file.buffer,
        filename,
        req.file.mimetype
      );
    }

    const updateQuery = profilePictureUrl
      ? "UPDATE profile SET name = ?, profile_picture_url = ? WHERE id = 1"
      : "UPDATE profile SET name = ? WHERE id = 1";

    const params = profilePictureUrl ? [name, profilePictureUrl] : [name];

    await sequelize.query(updateQuery, {
      replacements: params,
      type: Sequelize.QueryTypes.UPDATE,
    });

    res.json({
      success: true,
      data: {
        name,
        profile_picture_url: profilePictureUrl,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Feedback Routes
app.post("/feedback/rating", async (req, res) => {
  try {
    const { rating } = req.body;

    if (!rating) {
      return res.status(400).json({
        success: false,
        message: "Rating harus diisi",
      });
    }

    if (rating < 1 || rating > 4) {
      return res.status(400).json({
        success: false,
        message: "Rating harus antara 1-4",
      });
    }

    // Simpan rating ke database
    const [result] = await sequelize.query(
      "INSERT INTO feedback (rating) VALUES (?)",
      {
        replacements: [rating],
        type: Sequelize.QueryTypes.INSERT,
      }
    );

    res.status(201).json({
      success: true,
      message: "Rating berhasil disimpan",
      data: {
        id: result, // ID feedback untuk pembaruan di langkah berikutnya
        rating,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

app.put("/feedback/comment/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { comment } = req.body;

    if (!comment) {
      return res.status(400).json({
        success: false,
        message: "Komentar harus diisi",
      });
    }

    // Perbarui feedback dengan komentar
    const [result] = await sequelize.query(
      "UPDATE feedback SET comment = ? WHERE id = ?",
      {
        replacements: [comment, id],
        type: Sequelize.QueryTypes.UPDATE,
      }
    );

    if (result === 0) {
      return res.status(404).json({
        success: false,
        message: "Feedback tidak ditemukan",
      });
    }

    res.json({
      success: true,
      message: "Komentar berhasil ditambahkan",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: err.message,
  });
});

// Server & Database Initialization
const PORT = process.env.PORT || 3000;

const start = async () => {
  try {
    // Sync database
    await sequelize.sync();
    console.log("Database synced successfully");

    // Start server
    app.listen(PORT, () => {
      console.log(`Server berjalan di port ${PORT}`);
      console.log(`Test API at: http://localhost:${PORT}`);
      console.log("\nAvailable routes:");
      console.log("- POST   /soundboards");
      console.log("- GET    /soundboards");
      console.log("- POST   /history");
      console.log("- GET    /history");
      console.log("- GET    /history/:id");
      console.log("- GET    /profile");
      console.log("- PUT    /profile");
      console.log("- POST   /feedback");
    });
  } catch (error) {
    console.error("Unable to start server:", error);
    process.exit(1);
  }
};

start();
