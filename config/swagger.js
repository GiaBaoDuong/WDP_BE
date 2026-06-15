const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "WDP Manga API",
      version: "1.0.0",
      description: "Webcomic Distribution Platform — Manga Management API",
    },
    servers: [
      {
        url: "https://wdp-be-a2qb.onrender.com",
        description: "Production server",
      },
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Series: {
          type: "object",
          properties: {
            _id: { type: "string" },
            name: { type: "string" },
            description: { type: "string" },
            genre: { type: "string" },
            target_audience: { type: "string" },
            synopsis: { type: "string" },
            author_id: { type: "string" },
            status: { type: "string", enum: ["draft", "submitted", "approved", "rejected", "published", "cancelled"] },
            publication_schedule: { type: "string", enum: ["weekly", "monthly", "null"] },
            is_public: { type: "boolean" },
            average_score: { type: "number" },
            total_votes: { type: "integer" },
            views_count: { type: "integer" },
            cover_image_url: { type: "string" },
            category: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            age_rating: { type: "string", enum: ["All ages", "Teens 13+", "Mature 17+", "Adults Only 18+"] },
            eb_evaluation_id: { type: "string", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Chapter: {
          type: "object",
          properties: {
            _id: { type: "string" },
            series_id: { type: "string" },
            chapter_number: { type: "integer" },
            title: { type: "string" },
            status: { type: "string", enum: ["draft", "pending_assistant", "pending_TE", "TE_revision", "pending_EB", "EB_revision", "published"] },
            submitted_by: { type: "string" },
            te_review_id: { type: "string", nullable: true },
            eb_evaluation_id: { type: "string", nullable: true },
            assistant_id: { type: "string", nullable: true },
            revision_notes: { type: "string" },
            revision_annotations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  page_id: { type: "string" },
                  region: {
                    type: "object",
                    properties: {
                      x: { type: "number" },
                      y: { type: "number" },
                      width: { type: "number" },
                      height: { type: "number" },
                    },
                  },
                  content: { type: "string" },
                  error_type: { type: "string", enum: ["content", "dialogue", "script", "art", "other"] },
                },
              },
            },
            revision_source: { type: "string", enum: ["TE", "EB", ""] },
            is_published: { type: "boolean" },
            published_at: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Task: {
          type: "object",
          properties: {
            _id: { type: "string" },
            page_id: { type: "string" },
            chapter_id: { type: "string" },
            assigned_by: { type: "string" },
            assigned_to: { type: "string" },
            work_type: { type: "string", enum: ["background", "shading", "effects", "details", "other"] },
            region: {
              type: "object",
              properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } },
            },
            description: { type: "string" },
            revision_note: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "submitted", "approved", "revision"] },
            result_image_url: { type: "string" },
            price: { type: "number" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Vote: {
          type: "object",
          properties: {
            _id: { type: "string" },
            series_id: { type: "string" },
            reader_id: { type: "string" },
            score: { type: "integer", minimum: 1, maximum: 10 },
            comment: { type: "string" },
            release_period: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        TEReview: {
          type: "object",
          properties: {
            _id: { type: "string" },
            chapter_id: { type: "string" },
            reviewed_by: { type: "string" },
            decision: { type: "string", enum: ["approved", "revision"] },
            annotations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  _id: { type: "string" },
                  page_id: { type: "string" },
                  region: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, width: { type: "number" }, height: { type: "number" } } },
                  content: { type: "string" },
                  error_type: { type: "string", enum: ["content", "dialogue", "script", "art", "other"] },
                },
              },
            },
            feedback: { type: "string" },
            revision_feedback: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        EBEvaluation: {
          type: "object",
          properties: {
            _id: { type: "string" },
            series_id: { type: "string" },
            chapter_id: { type: "string", nullable: true },
            evaluated_by: { type: "string" },
            first_review: { type: "boolean" },
            member_scores: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  member_name: { type: "string" },
                  content_script: { type: "number" },
                  art: { type: "number" },
                  characters: { type: "number" },
                  commercial_potential: { type: "number" },
                  publisher_fit: { type: "number" },
                  total_score: { type: "number" },
                  notes: { type: "string" },
                },
              },
            },
            quick_decision: { type: "string", enum: ["approved", "rejected", "revision", "null"] },
            quick_notes: { type: "string" },
            result: { type: "string", enum: ["approved", "rejected", "revision", "null"] },
            publication_schedule: { type: "string", enum: ["weekly", "monthly", "null"] },
            notes: { type: "string" },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
        Notification: {
          type: "object",
          properties: {
            _id: { type: "string" },
            user_id: { type: "string" },
            type: { type: "string" },
            title: { type: "string" },
            message: { type: "string" },
            is_read: { type: "boolean" },
            related_entity_type: { type: "string", enum: ["series", "chapter", "page", "task", "cooperation_request", "cooperation", "te_review", "eb_evaluation", "vote"] },
            related_entity_id: { type: "string", nullable: true },
            meta: { type: "object", additionalProperties: true },
            createdAt: { type: "string", format: "date-time" },
            updatedAt: { type: "string", format: "date-time" },
          },
        },
      },
    },
    security: [{ BearerAuth: [] }],
  },
  apis: ["./routes/*.js"],
};

const swaggerSpec = swaggerJsdoc(options);
module.exports = swaggerSpec;
