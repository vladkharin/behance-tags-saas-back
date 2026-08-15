import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

export class ImportCaseDto {
  @IsUrl({}, { message: 'Укажите корректный URL кейса Behance' })
  @IsNotEmpty({ message: 'URL кейса обязателен' })
  url!: string;
}

export class ToggleScheduleDto {
  @IsBoolean({ message: 'isScheduled должно быть булевым значением (true/false)' })
  isScheduled!: boolean;
}

export class AnalyzeProjectDto {
  @IsOptional()
  @IsArray({ message: 'tags должен быть массивом строк' })
  @IsString({ each: true, message: 'Каждый тег должен быть строкой' })
  tags?: string[];
}

export class ToggleTagChartDto {
  @IsString({ message: 'tagName должен быть строкой' })
  @IsNotEmpty({ message: 'tagName обязателен' })
  tagName!: string;

  @IsBoolean({ message: 'state должно быть булевым значением' })
  state!: boolean;
}

export class ToggleAllTagsChartDto {
  @IsBoolean({ message: 'state должно быть булевым значением' })
  state!: boolean;
}
