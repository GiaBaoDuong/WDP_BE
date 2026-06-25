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
            status: { type: "string", enum: ["draft", "pending_assistant", "submitted_by_assistant", "pending_TE", "TE_revision", "pending_EB", "EB_revision", "published", "review"] },
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
            decision: { type: "string", enum: ["draft", "revision", "approved", "rejected", "approved_publish"] },
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
            scores: {
              type: "object",
              properties: {
                pacing_content: { type: "integer", minimum: 0, maximum: 5 },
                visual_art_writing: { type: "integer", minimum: 0, maximum: 5 },
                layout_storyboard: { type: "integer", minimum: 0, maximum: 5 },
                localization_technical: { type: "integer", minimum: 0, maximum: 5 },
              },
            },
            average_score: { type: "number", nullable: true },
            feedback: { type: "string" },
            revision_feedback: { type: "string" },
            quick_notes: { type: "string" },
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
            story_type: { type: "string" },
            preview_images: { type: "array", items: { type: "string" } },
            status: { type: "string", enum: ["scoring", "saved", "locked"] },
            first_review: { type: "boolean" },
            member_scores: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  member_name: { type: "string" },
                  member_id: { type: "string", nullable: true },
                  scores: {
                    type: "object",
                    properties: {
                      story_dialogue: { type: "number" },
                      art_design: { type: "number" },
                      panel_camera: { type: "number" },
                      pacing_climax: { type: "number" },
                      color: { type: "number" },
                    },
                  },
                  comments: {
                    type: "object",
                    properties: {
                      story_dialogue: { type: "string" },
                      art_design: { type: "string" },
                      panel_camera: { type: "string" },
                      pacing_climax: { type: "string" },
                      color: { type: "string" },
                    },
                  },
                  overall_comment: { type: "string" },
                  average: { type: "number" },
                  total_score: { type: "number" },
                  saved_at: { type: "string", format: "date-time" },
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
        EBScoreSummary: {
          type: "object",
          properties: {
            chapter_id: { type: "string" },
            series_id: { type: "string" },
            series_name: { type: "string" },
            evaluation_id: { type: "string", nullable: true },
            evaluation_status: { type: "string", enum: ["scoring", "saved", "locked"] },
            story_type: { type: "string" },
            member_stats: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  member_name: { type: "string" },
                  scores: {
                    type: "object",
                    properties: {
                      story_dialogue: { type: "number" },
                      art_design: { type: "number" },
                      panel_camera: { type: "number" },
                      pacing_climax: { type: "number" },
                      color: { type: "number" },
                    },
                  },
                  average: { type: "number" },
                  overall_comment: { type: "string" },
                  saved_at: { type: "string", format: "date-time" },
                },
              },
            },
            aggregate: {
              type: "object",
              nullable: true,
              properties: {
                scores_per_criteria: {
                  type: "object",
                  properties: {
                    story_dialogue: { type: "number" },
                    art_design: { type: "number" },
                    panel_camera: { type: "number" },
                    pacing_climax: { type: "number" },
                    color: { type: "number" },
                  },
                },
                council_average: { type: "number" },
                total_score: { type: "number" },
                label_code: { type: "string", enum: ["khong_dat", "dat", "tot", "xuat_sac"] },
                label_text: { type: "string", enum: ["Không đạt", "Đạt", "Tốt", "Xuất sắc"] },
                member_count: { type: "integer" },
              },
            },
            criteria_labels: {
              type: "object",
              additionalProperties: { type: "string" },
            },
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
