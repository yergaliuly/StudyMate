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
        RETURNING id, title, description, icon, tone, created_at, version, 0 AS lecture_count
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
          SELECT id, title, description, icon, tone, created_at, version,
            (SELECT count(*) FROM studymate.materials m JOIN studymate.material_objects o ON o.id=m.id
             WHERE m.subject_id=s.id AND m.owner_id=s.owner_id AND o.state='stored') AS lecture_count
          FROM studymate.subjects s
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

  Optional<SubjectResponse> find(UUID owner, UUID id, boolean forUpdate) {
    return jdbc.sql("""
        SELECT id, title, description, icon, tone, created_at, version,
          (SELECT count(*) FROM studymate.materials m JOIN studymate.material_objects o ON o.id=m.id
           WHERE m.subject_id=s.id AND m.owner_id=s.owner_id AND o.state='stored') AS lecture_count
        FROM studymate.subjects s
        WHERE owner_id = :owner AND id = :id
        """ + (forUpdate ? " FOR UPDATE" : ""))
        .param("owner", owner).param("id", id).query((row, number) -> subject(row)).optional();
  }

  SubjectResponse update(UUID owner, UUID id, SubjectCreateRequest values) {
    // Called after SELECT FOR UPDATE in the same transaction; the row cannot change or disappear.
    return jdbc.sql("""
        UPDATE studymate.subjects s SET title = :title, normalized_title = :titleKey,
            description = :description, normalized_description = :descriptionKey,
            icon = :icon, tone = :tone, version = version + 1
        WHERE owner_id = :owner AND id = :id
        RETURNING id, title, description, icon, tone, created_at, version,
          (SELECT count(*) FROM studymate.materials m JOIN studymate.material_objects o ON o.id=m.id
           WHERE m.subject_id=s.id AND m.owner_id=s.owner_id AND o.state='stored') AS lecture_count
        """)
        .param("owner", owner).param("id", id)
        .param("title", values.title()).param("titleKey", TextInput.searchKey(values.title()))
        .param("description", values.description()).param("descriptionKey", TextInput.searchKey(values.description()))
        .param("icon", values.icon()).param("tone", values.tone())
        .query((row, number) -> subject(row)).single();
  }

  boolean delete(UUID owner, UUID id) {
    // The non-deferrable material FK also protects concurrent inserts and unfinished cleanup.
    return jdbc.sql("DELETE FROM studymate.subjects WHERE owner_id = :owner AND id = :id")
        .param("owner", owner).param("id", id).update() == 1;
  }

  private record PageRow(SubjectResponse subject, long total) {}

  private static SubjectResponse subject(ResultSet row) throws SQLException {
    return new SubjectResponse(row.getObject("id", UUID.class), row.getString("title"), row.getString("description"),
        row.getString("icon"), row.getString("tone"), row.getInt("lecture_count"), null, row.getTimestamp("created_at").toInstant(), row.getLong("version"));
  }
}
