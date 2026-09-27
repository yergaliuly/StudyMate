package com.studymate.subjects;

import com.studymate.common.validation.TextInput;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class SubjectRepository {
  private final JdbcClient jdbc;
  SubjectRepository(JdbcClient jdbc) { this.jdbc = jdbc; }

  Optional<SubjectResponse> create(UUID owner, SubjectCreateRequest input) {
    return jdbc.sql("""
        INSERT INTO studymate.subjects (id, owner_id, title, normalized_title, description,
            normalized_description, icon, tone)
        VALUES (:id, :owner, :title, :titleKey, :description, :descriptionKey, :icon, :tone)
        ON CONFLICT ON CONSTRAINT subjects_owner_title_key DO NOTHING
        RETURNING id, title, description, icon, tone, created_at
        """)
        .param("id", UUID.randomUUID()).param("owner", owner)
        .param("title", input.title()).param("titleKey", TextInput.searchKey(input.title()))
        .param("description", input.description()).param("descriptionKey", TextInput.searchKey(input.description()))
        .param("icon", input.icon()).param("tone", input.tone())
        .query((row, number) -> subject(row)).optional();
  }

  SubjectPage list(UUID owner, SubjectQuery query) {
    // A single statement gives the page and total one MVCC snapshot, even for an empty/out-of-range page.
    var rows = jdbc.sql("""
        WITH filtered AS (
          SELECT id, title, description, icon, tone, created_at FROM studymate.subjects
          WHERE owner_id = :owner AND (:q = '' OR strpos(normalized_title, :q) > 0
              OR strpos(normalized_description, :q) > 0)
        ), page AS (
          SELECT * FROM filtered ORDER BY created_at DESC, id DESC LIMIT :limit OFFSET :offset
        )
        SELECT page.*, totals.total FROM (SELECT count(*) AS total FROM filtered) totals
        LEFT JOIN page ON TRUE ORDER BY page.created_at DESC, page.id DESC
        """)
        .param("owner", owner).param("q", query.q()).param("limit", query.pageSize()).param("offset", query.offset())
        .query((row, number) -> new PageRow(row.getObject("id") == null ? null : subject(row), row.getLong("total")))
        .list();
    return new SubjectPage(rows.stream().map(PageRow::subject).filter(java.util.Objects::nonNull).toList(),
        new SubjectPage.Meta(query.page(), query.pageSize(), rows.getFirst().total()));
  }

  private record PageRow(SubjectResponse subject, long total) {}

  private static SubjectResponse subject(ResultSet row) throws SQLException {
    // No material storage exists until stage 8: every subject currently has exactly zero materials.
    // Do not persist this count or invent a progress value; replace count projection when materials arrive.
    return new SubjectResponse(row.getObject("id", UUID.class), row.getString("title"), row.getString("description"),
        row.getString("icon"), row.getString("tone"), 0, null, row.getTimestamp("created_at").toInstant());
  }
}
