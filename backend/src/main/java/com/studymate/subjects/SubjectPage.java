package com.studymate.subjects;

import java.util.List;

record SubjectPage(List<SubjectResponse> data, Meta meta) {
  record Meta(long page, int pageSize, long total) {}
}
